export class AgentError {
  readonly _tag = "AgentError";
  constructor(
    readonly message: string,
    readonly cause?: unknown,
  ) {}
}
