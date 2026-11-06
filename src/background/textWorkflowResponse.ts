// Only reject known non-text envelopes. Plain source code, prose reviews and
// answers containing an image alongside real text must remain valid.
export function isMissingWorkflowText(response: string): boolean {
  const text = response.trim();
  return !text || /^\[Image generated(?::[^\r\n]*)?\]$/i.test(text);
}
