export type LogFields = Record<
  string,
  string | number | boolean | null | string[]
>;

export interface StructuredLogger {
  info(event: string, fields: LogFields): void;
  error(event: string, fields: LogFields): void;
}

export const silentLogger: StructuredLogger = {
  info: () => undefined,
  error: () => undefined,
};

export class ConsoleStructuredLogger implements StructuredLogger {
  info(event: string, fields: LogFields): void {
    console.info(JSON.stringify({ level: "info", event, ...fields }));
  }

  error(event: string, fields: LogFields): void {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  }
}
