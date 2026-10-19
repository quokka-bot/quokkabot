export const REPORT_SUBJECT = "Report a response";

export function reportBody(text: string, origin: string, taskId: string): string {
  return `Report a response\n\n${text}\n\nServer: ${new URL(origin).host}\nTask: ${taskId}`;
}

export async function reportResponse(input: { text: string; origin: string; taskId: string; email: string; supportUrl: string }, device: {
  mailAvailable: () => Promise<boolean>;
  compose: (options: { recipients: string[]; subject: string; body: string }) => Promise<unknown>;
  copy: (text: string) => Promise<unknown>;
  open: (url: string) => Promise<unknown>;
}): Promise<void> {
  const body = reportBody(input.text, input.origin, input.taskId);
  if (await device.mailAvailable()) {
    await device.compose({ recipients: [input.email], subject: REPORT_SUBJECT, body });
  } else {
    await device.copy(body);
    await device.open(input.supportUrl);
  }
}

export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
