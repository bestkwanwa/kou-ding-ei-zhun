/**
 * Format filesystem errors into clear, actionable messages for the LLM.
 */
export function formatFsError(err: unknown, filePath: string): string {
  const e = err as NodeJS.ErrnoException;
  switch (e.code) {
    case "ENOENT":
      return `Error: path not found: "${filePath}". Check that the path is correct and the file or directory exists.`;
    case "EACCES":
      return `Error: permission denied: "${filePath}". Check file/directory permissions.`;
    case "EISDIR":
      return `Error: expected a file but path is a directory: "${filePath}".`;
    case "ENOTDIR":
      return `Error: expected a directory but path is a file: "${filePath}".`;
    case "ENOSPC":
      return `Error: no space left on device when writing: "${filePath}".`;
    case "EROFS":
      return `Error: cannot write to read-only filesystem: "${filePath}".`;
    default:
      return `Error: ${e.message ?? "unknown error"} (path: "${filePath}")`;
  }
}
