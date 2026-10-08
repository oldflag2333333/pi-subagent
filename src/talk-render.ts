export interface TalkView {
	lines: string[];
	remaining: number;
	totalLines: number;
}

export function talkView(message: string, expanded: boolean, maxCollapsedLines = 3): TalkView {
	const normalized = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");
	while (lines.length > 1 && lines.at(-1) === "") lines.pop();
	const totalLines = lines.length;
	const visibleLines = expanded ? lines : lines.slice(0, maxCollapsedLines);
	return {
		lines: visibleLines,
		remaining: totalLines - visibleLines.length,
		totalLines,
	};
}
