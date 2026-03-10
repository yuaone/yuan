/**
 * useSlashCommands — slash command registry and fuzzy matching.
 */

import { useState, useMemo, useCallback } from "react";
import type { SlashCommand } from "../types.js";
import { getCommandDefs, isKnownCommand as checkCommand } from "../../commands/index.js";

const DEFAULT_COMMANDS: SlashCommand[] = getCommandDefs().map(def => ({
  name: def.name,
  description: def.description,
  aliases: def.aliases,
}));

/** Check if a string is a known command name (exact or alias match) */
export function isKnownCommand(input: string): boolean {
  return checkCommand(input);
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
