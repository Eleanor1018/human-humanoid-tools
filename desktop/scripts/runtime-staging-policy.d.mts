export interface ApplicationSourceFiles {
  provenance: 'git-tracked-worktree' | 'trusted-archive'
  files: string[]
}

export function listApplicationSourceFiles(
  repositoryRoot: string,
  inputs: string[],
  env?: NodeJS.ProcessEnv
): ApplicationSourceFiles

export function resolveBundledRobotDirectory(
  env?: NodeJS.ProcessEnv,
  cwd?: string
): string | null

export function assertRobotDestinationAvailable(destination: string, robotName: string): void

export function assertPathInside(
  root: string,
  candidate: string,
  description: string,
  options?: { allowRoot?: boolean }
): void
