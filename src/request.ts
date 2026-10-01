import * as vscode from 'vscode';
import type { EditorContextInfo } from './sidecar';

export interface ParsedRequest {
	/** What the developer actually typed, without Copilot's injected context. */
	prompt: string;
	/** Stable id of the user turn; tool-call round trips within one turn share it. */
	turnKey: string;
	/** True when this call continues a tool loop rather than starting a new turn. */
	continuation: boolean;
	context: EditorContextInfo;
}

const USER_REQUEST = /<userRequest>([\s\S]*?)<\/userRequest>/i;
// Blocks Copilot wraps around the request: workspace info, attachments, reminders...
const INJECTED_BLOCK = /<([a-zA-Z_][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/g;

function textOf(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.map(part => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
		.join('');
}

function hasToolResult(message: vscode.LanguageModelChatRequestMessage): boolean {
	return message.content.some(part => part instanceof vscode.LanguageModelToolResultPart);
}

function hasImage(message: vscode.LanguageModelChatRequestMessage): boolean {
	return message.content.some(
		part => part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith('image/'),
	);
}

/** The developer's own words in a message, or '' when it only carries injected context. */
export function userRequestText(raw: string): string {
	const tagged = USER_REQUEST.exec(raw);
	if (tagged) {
		return tagged[1].trim();
	}
	return raw.replace(INJECTED_BLOCK, '').replace(/<\/?[a-zA-Z_][\w-]*[^>]*>/g, '').trim();
}

function roughTokens(message: vscode.LanguageModelChatRequestMessage): number {
	let chars = 0;
	for (const part of message.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			chars += part.value.length;
		} else if (part instanceof vscode.LanguageModelToolResultPart) {
			for (const inner of part.content) {
				if (inner instanceof vscode.LanguageModelTextPart) {
					chars += inner.value.length;
				}
			}
		} else if (part instanceof vscode.LanguageModelToolCallPart) {
			chars += JSON.stringify(part.input).length;
		}
	}
	return Math.ceil(chars / 4);
}

export function parseRequest(
	messages: readonly vscode.LanguageModelChatRequestMessage[],
	tools: number,
): ParsedRequest {
	const User = vscode.LanguageModelChatMessageRole.User;
	// Real turns are user messages with typed words; Copilot also appends user messages that
	// hold only tagged context (attachments, reminders), and those must not be read as the ask.
	const turns = messages
		.filter(m => m.role === User && !hasToolResult(m))
		.map(m => ({ request: userRequestText(textOf(m)) }))
		.filter(t => t.request);
	const last = turns[turns.length - 1];
	const prompt = last?.request ?? '';
	const history = turns.slice(0, -1).map(t => t.request).slice(-3);
	// Attachments can sit in the turn's own message or in a context message after it.
	const raw = messages
		.filter(m => m.role === User && !hasToolResult(m))
		.slice(-3)
		.map(textOf)
		.join('\n');
	const tail = messages[messages.length - 1];
	const attachments = (raw.match(/<attachment[\s>]/g) ?? []).length;
	const editor = vscode.window.activeTextEditor;
	return {
		prompt,
		turnKey: `${turns.length}:${prompt}`,
		continuation: !!tail && hasToolResult(tail),
		context: {
			attachments,
			tools,
			turns: turns.length,
			estimated_tokens: messages.reduce((sum, m) => sum + roughTokens(m), 0),
			has_images: messages.some(hasImage),
			language_id: editor?.document.languageId,
			history,
		},
	};
}

/** One line per message: role, part kinds and a short preview. For the output channel. */
export function describeMessages(messages: readonly vscode.LanguageModelChatRequestMessage[]): string {
	return messages
		.map((m, i) => {
			const parts = m.content.map(part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					const tags = [...new Set(part.value.match(/<([a-zA-Z_][\w-]*)[\s>]/g) ?? [])].slice(0, 8).join('');
					const plain = part.value.replace(INJECTED_BLOCK, '').replace(/\s+/g, ' ').trim().slice(0, 100);
					return `text(${part.value.length}${tags ? ' ' + tags : ''}) "${plain}"`;
				}
				if (part instanceof vscode.LanguageModelToolResultPart) {
					return 'toolResult';
				}
				if (part instanceof vscode.LanguageModelToolCallPart) {
					return `toolCall(${part.name})`;
				}
				return part && typeof part === 'object' ? part.constructor.name : typeof part;
			});
			return `  #${i} role=${m.role} ${parts.join(' + ')}`;
		})
		.join('\n');
}
