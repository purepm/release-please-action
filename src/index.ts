// Copyright 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import * as core from '@actions/core';
import {GitHub, Manifest, CreatedRelease, PullRequest, VERSION} from 'release-please';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {execFile as execFileCallback} from 'child_process';
import {promisify} from 'util';

const DEFAULT_CONFIG_FILE = 'release-please-config.json';
const DEFAULT_MANIFEST_FILE = '.release-please-manifest.json';
const DEFAULT_GITHUB_API_URL = 'https://api.github.com';
const DEFAULT_GITHUB_GRAPHQL_URL = 'https://api.github.com';
const DEFAULT_GITHUB_SERVER_URL = 'https://github.com';
const DEFAULT_SIGNING_BOT_NAME = 'release-please[bot]';
const DEFAULT_SIGNING_BOT_EMAIL = 'release-please[bot]@users.noreply.github.com';
const execFile = promisify(execFileCallback);

interface Proxy {
  host: string;
  port: number;
}

interface ActionInputs {
  token: string;
  repoUrl: string;
  releaseType?: string;
  path?: string;
  githubApiUrl: string;
  githubGraphqlUrl: string;
  configFile?: string;
  manifestFile?: string;
  proxyServer?: string;
  targetBranch?: string;
  skipGitHubRelease?: boolean;
  skipGitHubPullRequest?: boolean;
  skipLabeling?: boolean;
  fork?: boolean;
  includeComponentInTag?: boolean;
  changelogHost: string;
  versioningStrategy?: string;
  releaseAs?: string;
  signCommits?: boolean;
  gpgPrivateKey?: string;
  gpgPassphrase?: string;
  gitCommitterName?: string;
  gitCommitterEmail?: string;
}

function parseInputs(): ActionInputs {
  const inputs: ActionInputs = {
    token: core.getInput('token', {required: true}),
    releaseType: getOptionalInput('release-type'),
    path: getOptionalInput('path'),
    repoUrl: core.getInput('repo-url') || process.env.GITHUB_REPOSITORY || '',
    targetBranch: getOptionalInput('target-branch'),
    configFile: core.getInput('config-file') || DEFAULT_CONFIG_FILE,
    manifestFile: core.getInput('manifest-file') || DEFAULT_MANIFEST_FILE,
    githubApiUrl: core.getInput('github-api-url') || DEFAULT_GITHUB_API_URL,
    githubGraphqlUrl:
      (core.getInput('github-graphql-url') || '').replace(/\/graphql$/, '') ||
      DEFAULT_GITHUB_GRAPHQL_URL,
    proxyServer: getOptionalInput('proxy-server'),
    skipGitHubRelease: getOptionalBooleanInput('skip-github-release'),
    skipGitHubPullRequest: getOptionalBooleanInput('skip-github-pull-request'),
    skipLabeling: getOptionalBooleanInput('skip-labeling'),
    fork: getOptionalBooleanInput('fork'),
    includeComponentInTag: getOptionalBooleanInput('include-component-in-tag'),
    changelogHost: core.getInput('changelog-host') || DEFAULT_GITHUB_SERVER_URL,
    versioningStrategy: getOptionalInput('versioning-strategy'),
    releaseAs: getOptionalInput('release-as'),
    signCommits: getOptionalBooleanInput('sign-commits'),
    gpgPrivateKey: getOptionalInput('gpg-private-key'),
    gpgPassphrase: getOptionalInput('gpg-passphrase'),
    gitCommitterName: getOptionalInput('git-committer-name'),
    gitCommitterEmail: getOptionalInput('git-committer-email'),
  };
  return inputs;
}

function getOptionalInput(name: string): string | undefined {
  return core.getInput(name) || undefined;
}

function getOptionalBooleanInput(name: string): boolean | undefined {
  const val = core.getInput(name);
  if (val === '' || val === undefined) {
    return undefined;
  }
  return core.getBooleanInput(name);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function loadOrBuildManifest(
  github: GitHub,
  inputs: ActionInputs
): Promise<Manifest> {
  if (inputs.releaseType) {
    core.debug('Building manifest from config');
    return Manifest.fromConfig(
      github,
      github.repository.defaultBranch,
      {
        releaseType: inputs.releaseType,
        includeComponentInTag: inputs.includeComponentInTag,
        changelogHost: inputs.changelogHost,
        versioning: inputs.versioningStrategy,
        releaseAs: inputs.releaseAs,
      },
      {
        fork: inputs.fork,
        skipLabeling: inputs.skipLabeling,
      },
      inputs.path
    );
  }
  const manifestOverrides = inputs.fork || inputs.skipLabeling
    ? {
        fork: inputs.fork,
        skipLabeling: inputs.skipLabeling,
      }
    : {};
  core.debug('Loading manifest from config file');
  return Manifest.fromManifest(
    github,
    github.repository.defaultBranch,
    inputs.configFile,
    inputs.manifestFile,
    manifestOverrides
  ).then(manifest => {
    // Override changelogHost for all paths if provided as action input and different from default
    if (inputs.changelogHost && inputs.changelogHost !== DEFAULT_GITHUB_SERVER_URL) {
      core.debug(`Overriding changelogHost to: ${inputs.changelogHost}`);
      for (const path in manifest.repositoryConfig) {
        manifest.repositoryConfig[path].changelogHost = inputs.changelogHost;
      }
    }
    return manifest;
  });
}

export async function main(fetchOverride?: any) {
  core.info(`Running release-please version: ${VERSION}`)
  const inputs = parseInputs();
  validateSigningInputs(inputs);
  const github = await getGitHubInstance(inputs, fetchOverride);

  if (!inputs.skipGitHubRelease) {
    const manifest = await loadOrBuildManifest(github, inputs);
    core.debug('Creating releases');
    outputReleases(await manifest.createReleases());
  }

  if (!inputs.skipGitHubPullRequest) {
    const manifest = await loadOrBuildManifest(github, inputs);
    core.debug('Creating pull requests');
    const prs = await manifest.createPullRequests();
    if (inputs.signCommits) {
      await internals.signReleasePleaseBranchCommits(inputs, prs);
    }
    outputPRs(prs);
  }
}

function validateSigningInputs(inputs: ActionInputs) {
  if (!inputs.signCommits) return;
  if (!inputs.gpgPrivateKey) {
    throw new Error('gpg-private-key must be provided when sign-commits is true');
  }
}

interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

async function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions = {}
): Promise<{stdout: string; stderr: string}> {
  const {stdout, stderr} = await execFile(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: 'utf8',
  });
  return {stdout, stderr};
}

function getSigningKeyFingerprint(listOutput: string): string {
  for (const line of listOutput.split('\n')) {
    const parts = line.split(':');
    if (parts[0] === 'fpr' && parts[9]) return parts[9];
  }
  throw new Error('Could not detect imported GPG key fingerprint');
}

function getRemoteUrl(inputs: ActionInputs): string {
  const serverUrl = process.env.GITHUB_SERVER_URL || DEFAULT_GITHUB_SERVER_URL;
  const parsedServerUrl = new URL(serverUrl);
  const repoPath = inputs.repoUrl.replace(/\.git$/, '');
  return `${parsedServerUrl.protocol}//${parsedServerUrl.host}/${repoPath}.git`;
}

async function signReleasePleaseBranchCommits(
  inputs: ActionInputs,
  prs: (PullRequest | undefined)[]
) {
  const branchNames = Array.from(
    new Set(
      prs
        .filter(isDefined)
        .map(pr => pr.headBranchName)
        .filter((branchName): branchName is string => Boolean(branchName))
    )
  );

  if (!branchNames.length) {
    core.info('No release-please branch commits to sign');
    return;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-please-signing-'));
  const gnupgHome = path.join(tmpDir, 'gnupg');
  const repoDir = path.join(tmpDir, 'repo');
  const keyFile = path.join(tmpDir, 'private.key');
  const gpgWrapperPath = path.join(tmpDir, 'gpg-wrapper.sh');
  const passphraseFile = path.join(tmpDir, 'passphrase.txt');
  const gitAskpassPath = path.join(tmpDir, 'git-askpass.sh');

  try {
    await fs.mkdir(gnupgHome, {mode: 0o700});
    await fs.mkdir(repoDir);
    await fs.writeFile(keyFile, inputs.gpgPrivateKey || '', {mode: 0o600});

    const gpgEnv: NodeJS.ProcessEnv = {
      ...process.env,
      GNUPGHOME: gnupgHome,
    };
    await fs.writeFile(
      gitAskpassPath,
      '#!/bin/sh\n' +
        'case "$1" in\n' +
        '  *Username*) echo "x-access-token" ;;\n' +
        '  *) echo "$RELEASE_PLEASE_TOKEN" ;;\n' +
        'esac\n',
      {mode: 0o700}
    );
    gpgEnv.RELEASE_PLEASE_TOKEN = inputs.token;
    gpgEnv.GIT_ASKPASS = gitAskpassPath;
    gpgEnv.GIT_TERMINAL_PROMPT = '0';

    await runCommand('gpg', ['--batch', '--import', keyFile], {env: gpgEnv});
    const {stdout: keyListOutput} = await runCommand(
      'gpg',
      ['--batch', '--list-secret-keys', '--with-colons', '--fingerprint'],
      {env: gpgEnv}
    );
    const signingKeyFingerprint = getSigningKeyFingerprint(keyListOutput);

    let gpgProgram = 'gpg';
    if (inputs.gpgPassphrase) {
      await fs.writeFile(passphraseFile, inputs.gpgPassphrase, {mode: 0o600});
      await fs.writeFile(
        gpgWrapperPath,
        '#!/bin/sh\nexec gpg --batch --pinentry-mode loopback --passphrase-file "$GPG_PASSPHRASE_FILE" "$@"\n',
        {mode: 0o700}
      );
      gpgProgram = gpgWrapperPath;
      gpgEnv.GPG_PASSPHRASE_FILE = passphraseFile;
    }

    await runCommand('git', ['init', '.'], {cwd: repoDir, env: gpgEnv});
    await runCommand('git', ['config', 'user.name', inputs.gitCommitterName || DEFAULT_SIGNING_BOT_NAME], {
      cwd: repoDir,
      env: gpgEnv,
    });
    await runCommand('git', ['config', 'user.email', inputs.gitCommitterEmail || DEFAULT_SIGNING_BOT_EMAIL], {
      cwd: repoDir,
      env: gpgEnv,
    });
    await runCommand('git', ['config', 'user.signingkey', signingKeyFingerprint], {
      cwd: repoDir,
      env: gpgEnv,
    });
    await runCommand('git', ['config', 'gpg.program', gpgProgram], {cwd: repoDir, env: gpgEnv});
    await runCommand('git', ['config', 'commit.gpgsign', 'true'], {cwd: repoDir, env: gpgEnv});
    await runCommand('git', ['remote', 'add', 'origin', getRemoteUrl(inputs)], {
      cwd: repoDir,
      env: gpgEnv,
    });

    for (const branchName of branchNames) {
      core.info(`Signing latest commit on branch ${branchName}`);
      await runCommand('git', ['fetch', '--depth=2', 'origin', branchName], {cwd: repoDir, env: gpgEnv});
      await runCommand('git', ['checkout', '--detach', 'FETCH_HEAD'], {cwd: repoDir, env: gpgEnv});
      await runCommand('git', ['commit', '--amend', '--no-edit', '--gpg-sign'], {
        cwd: repoDir,
        env: gpgEnv,
      });
      await runCommand('git', ['push', '--force-with-lease', 'origin', `HEAD:${branchName}`], {
        cwd: repoDir,
        env: gpgEnv,
      });
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true});
  }
}

export const internals = {
  runCommand,
  signReleasePleaseBranchCommits,
};

function getGitHubInstance(inputs: ActionInputs, fetchOverride?: any): Promise<GitHub> {
  const [owner, repo] = inputs.repoUrl.split('/');
  let proxy: Proxy | undefined = undefined;
  if (inputs.proxyServer) {
    const [host, port] = inputs.proxyServer.split(':');
    proxy = {
      host,
      port: parseInt(port),
    };
  }

  const githubCreateOpts = {
    proxy,
    owner,
    repo,
    apiUrl: inputs.githubApiUrl,
    graphqlUrl: inputs.githubGraphqlUrl,
    token: inputs.token,
    defaultBranch: inputs.targetBranch,
    fetch: fetchOverride,
  };
  return GitHub.create(githubCreateOpts);
}

function setPathOutput(path: string, key: string, value: string | boolean) {
  if (path === '.') {
    core.setOutput(key, value);
  } else {
    core.setOutput(`${path}--${key}`, value);
  }
}

function outputReleases(releases: (CreatedRelease | undefined)[]) {
  releases = releases.filter(release => release !== undefined);
  const pathsReleased = [];
  core.setOutput('releases_created', releases.length > 0);
  if (releases.length) {
    for (const release of releases) {
      if (!release) {
        continue;
      }
      const path = release.path || '.';
      if (path) {
        pathsReleased.push(path);
        // If the special root release is set (representing project root)
        // and this is explicitly a manifest release, set the release_created boolean.
        setPathOutput(path, 'release_created', true);
      }
      for (const [rawKey, value] of Object.entries(release)) {
        let key = rawKey;
        // Historically tagName was output as tag_name, keep this
        // consistent to avoid breaking change:
        if (key === 'tagName') key = 'tag_name';
        if (key === 'uploadUrl') key = 'upload_url';
        if (key === 'notes') key = 'body';
        if (key === 'url') key = 'html_url';
        setPathOutput(path, key, value);
      }
    }
  }
  // Paths of all releases that were created, so that they can be passed
  // to matrix in next step:
  core.setOutput('paths_released', JSON.stringify(pathsReleased));
}

function outputPRs(prs: (PullRequest | undefined)[]) {
  prs = prs.filter(pr => pr !== undefined);
  core.setOutput('prs_created', prs.length > 0);
  if (prs.length) {
    core.setOutput('pr', prs[0]);
    core.setOutput('prs', JSON.stringify(prs));
  }
}

if (require.main === module) {
  main().catch(err => {
    core.setFailed(`release-please failed: ${err.message}`)
  })
}
