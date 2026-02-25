/// <reference types="node" />
import { PullRequest } from 'release-please';
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
export declare function main(fetchOverride?: any): Promise<void>;
interface RunCommandOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}
declare function runCommand(command: string, args: string[], options?: RunCommandOptions): Promise<{
    stdout: string;
    stderr: string;
}>;
declare function signReleasePleaseBranchCommits(inputs: ActionInputs, prs: (PullRequest | undefined)[]): Promise<void>;
export declare const internals: {
    runCommand: typeof runCommand;
    signReleasePleaseBranchCommits: typeof signReleasePleaseBranchCommits;
};
export {};
