// Shared text is transient intake only. It must never remain in URL history.
export function readShareIntake(url, limit) {
  const parsed = new URL(url);
  const hadShare = parsed.searchParams.has('share');
  const text = parsed.searchParams.get('share');
  parsed.searchParams.delete('share');
  const cleanPath = `${parsed.pathname}${parsed.search}${parsed.hash || '#home'}`;
  return {
    hadShare,
    text: typeof text === 'string' && text.length <= limit ? text : null,
    cleanPath,
  };
}
