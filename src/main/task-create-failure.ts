export class TaskCreateFailure extends Error {
  constructor(message: string, readonly outcome: "not-created" | "unknown", options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskCreateFailure";
  }
}
