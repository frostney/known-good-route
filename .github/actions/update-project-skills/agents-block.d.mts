// Types for the eval harness, which generates each fixture's AGENTS.md block.
export declare const AGENTS_FILE: string;
export declare const INSTALLED_SKILLS_DIRECTORY: string;
export declare const MARKER_BEGIN: string;
export declare const MARKER_END: string;
export declare function writeAgentsBlock(
  projectRoot: string,
): Promise<{ changed: boolean; path: string }>;
export declare function verifyAgentsBlock(
  projectRoot: string,
): Promise<{ inSync: boolean; path: string }>;
