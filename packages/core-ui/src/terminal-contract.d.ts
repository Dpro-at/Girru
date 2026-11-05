export type TerminalFrame = { type: 'output'; seq: number; data: string } | { type: 'exit'; exitCode: number; signal?: number };
export type TerminalTheme = 'dpro-night' | 'dpro-day' | 'graphite' | 'midnight' | 'ocean' | 'forest' | 'paper' | 'contrast';
export type TerminalFont = 'system' | 'sf-mono' | 'menlo' | 'monaco' | 'jetbrains' | 'fira' | 'cascadia' | 'courier';
export type TerminalPrefs = { theme: TerminalTheme; fontFamily: TerminalFont; fontSize: number; lineHeight: number; letterSpacing: number; cursorStyle: 'block' | 'bar' | 'underline'; cursorBlink: boolean; scrollback: number; copyOnSelect: boolean };
export const TERMINAL_THEMES: readonly TerminalTheme[];
export const TERMINAL_FONTS: readonly TerminalFont[];
export const TERMINAL_CURSORS: readonly ['block', 'bar', 'underline'];
export const DEFAULT_TERMINAL_PREFS: Readonly<TerminalPrefs>;
export function terminalPrefOk(key: string, value: unknown): boolean;
export function terminalPrefs(x: unknown): TerminalPrefs;
export type TerminalRoute = { kind: 'info' | 'create' | 'prefs' } | { kind: 'close' | 'input' | 'resize' | 'stop'; id: string } | { kind: 'stream'; id: string; after: number };
export const TERMINAL_INPUT_CHARS: number;
export const TERMINAL_STREAM_MS: number;
export function terminalPath(path: string): TerminalRoute | null;
export function terminalRoute(path: string): boolean;
export function allowedTerminal(method: string, path: string, body?: unknown): boolean;
export function terminalResponse(path: string, status: number, body: unknown): unknown;
export class TerminalEventParser {
  constructor(after?: number);
  last: number;
  ended: boolean;
  push(bytes: Uint8Array): TerminalFrame[];
  finish(): TerminalFrame[];
}

export function safeTerminalCommand(command: unknown): command is string;
export function terminalLanguageMatches(language: string, shell: string): boolean;
