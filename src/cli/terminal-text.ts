import stringWidth from 'string-width';

const GRAPHEME_SEGMENTER = new Intl.Segmenter();
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');
const ANSI_RESET = `${String.fromCharCode(27)}[0m`;

function sliceByDisplayWidth(value: string, width: number): string {
  let result = '';
  let usedWidth = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(value)) {
    const segmentWidth = stringWidth(segment);
    if (usedWidth + segmentWidth > width) break;
    result += segment;
    usedWidth += segmentWidth;
  }
  return result;
}

function sliceAnsiByDisplayWidth(value: string, width: number): string {
  const ansiPattern = new RegExp(ANSI_PATTERN.source, 'g');
  let result = '';
  let usedWidth = 0;
  let cursor = 0;

  const appendVisibleText = (text: string): boolean => {
    for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
      const segmentWidth = stringWidth(segment);
      if (usedWidth + segmentWidth > width) return false;
      result += segment;
      usedWidth += segmentWidth;
    }
    return true;
  };

  for (const match of value.matchAll(ansiPattern)) {
    if (!appendVisibleText(value.slice(cursor, match.index))) return result;
    result += match[0];
    cursor = match.index + match[0].length;
  }
  appendVisibleText(value.slice(cursor));
  return result;
}

function truncateByDisplayWidth(value: string, width: number): string {
  if (width <= 0) return '';
  const truncated = `${sliceAnsiByDisplayWidth(value, width - 1)}…`;
  return new RegExp(ANSI_PATTERN.source).test(value) ? `${truncated}${ANSI_RESET}` : truncated;
}

function splitAtDisplayWidth(value: string, width: number): { line: string; remaining: string } {
  const candidate = sliceByDisplayWidth(value, width + 1);
  const breakAt = candidate.lastIndexOf(' ');
  if (breakAt > 0) {
    return {
      line: value.slice(0, breakAt),
      remaining: value.slice(breakAt + 1).trimStart(),
    };
  }
  const line = sliceByDisplayWidth(value, width);
  return {
    line,
    remaining: value.slice(line.length),
  };
}

export function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const result: string[] = [];
  for (const sourceLine of text.replace(/\r\n/g, '\n').split('\n')) {
    let remaining = sourceLine;
    while (stringWidth(remaining) > safeWidth) {
      const split = splitAtDisplayWidth(remaining, safeWidth);
      result.push(split.line);
      remaining = split.remaining;
    }
    result.push(remaining);
  }
  return result;
}

export function visibleText(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

export function fitColumn(value: string, width: number): string {
  const visible = visibleText(value);
  const visibleWidth = stringWidth(visible);
  if (visibleWidth > width) return truncateByDisplayWidth(value, width);
  return value + ' '.repeat(width - visibleWidth);
}

export function truncateColumn(value: string, width: number): string {
  const visible = visibleText(value);
  if (stringWidth(visible) <= width) return value;
  return truncateByDisplayWidth(value, width);
}
