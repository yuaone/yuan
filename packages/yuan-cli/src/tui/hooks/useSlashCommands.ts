/**
 * useSlashCommands — slash command registry and fuzzy matching.
 */

import { useState, useMemo, useCallback } from "react";
import type { SlashCommand } from "../types.js";

const DEFAULT_COMMANDS: SlashCommand[] = [
  { name: "/help", description: "Show available commands", aliases: ["/h"] },
  { name: "/status", description: "Model, tokens, session info" },
  { name: "/clear", description: "Clear conversation history" },
  { name: "/model", description: "Change model" },
  { name: "/config", description: "Show/edit configuration" },
  { name: "/session", description: "Session management" },
  { name: "/diff", description: "Show recent diffs" },
  { name: "/undo", description: "Undo last change" },
  { name: "/settings", description: "Auto-update, preferences" },
  { name: "/exit", description: "Exit YUAN", aliases: ["/quit", "/q"] },
];

/** Check if a string is a known command name (exact or alias match) */
export function isKnownCommand(input: string): boolean {
  const q = input.trim().toLowerCase().split(" ")[0];
  return DEFAULT_COMMANDS.some(
    (cmd) =>
      cmd.name === q ||
      cmd.aliases?.includes(q),
  );
}

export interface SlashCommandState {
  commands: SlashCommand[];
  filtered: SlashCommand[];
  selectedIndex: number;
  isOpen: boolean;
}

export interface SlashCommandActions {
  filter: (query: string) => void;
  selectNext: () => void;
  selectPrev: () => void;
  getSelected: () => SlashCommand | null;
  open: () => void;
  close: () => void;
}

export function useSlashCommands(
  extraCommands: SlashCommand[] = [],
): [SlashCommandState, SlashCommandActions] {
  const commands = useMemo(
    () => [...DEFAULT_COMMANDS, ...extraCommands],
    [extraCommands],
  );

  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const filtered = useMemo(() => {
    if (!query || query === "/") return commands;
    const q = query.toLowerCase();
    return commands.filter(
      (cmd) =>
        cmd.name.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q) ||
        cmd.aliases?.some((a) => a.toLowerCase().includes(q)),
    );
  }, [commands, query]);

  const filter = useCallback((q: string) => {
    setQuery(q);
    setSelectedIndex(0);
    setIsOpen(q.startsWith("/"));
  }, []);

  const selectNext = useCallback(() => {
    setSelectedIndex((prev) => Math.min(prev + 1, filtered.length - 1));
  }, [filtered.length]);

  const selectPrev = useCallback(() => {
    setSelectedIndex((prev) => Math.max(prev - 1, 0));
  }, []);

  const getSelected = useCallback((): SlashCommand | null => {
    return filtered[selectedIndex] ?? null;
  }, [filtered, selectedIndex]);

  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => {
    setIsOpen(false);
    setQuery("");
    setSelectedIndex(0);
  }, []);

  return [
    { commands, filtered, selectedIndex, isOpen },
    { filter, selectNext, selectPrev, getSelected, open, close },
  ];
}
