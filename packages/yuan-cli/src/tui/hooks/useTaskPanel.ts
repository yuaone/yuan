/**
 * useTaskPanel — state management for the background agent task panel.
 *
 * Modes:
 *   closed  → panel not visible
 *   list    → task list with cursor
 *   detail  → step tree for a specific task
 *
 * Navigation wired through InputBox:
 *   ↑↓ when panel open → call navigateUp / navigateDown
 *   enter when list mode → call expandSelected
 *   esc → closeDetail (detail→list) or close (list→closed)
 */

import { useState, useCallback } from "react";
import type { TaskPanelMode } from "../components/TaskPanel.js";

export interface UseTaskPanelReturn {
  isOpen: boolean;
  mode: TaskPanelMode;
  selectedIndex: number;
  detailTaskId: string | null;
  open: () => void;
  close: () => void;
  navigateUp: () => void;
  navigateDown: (taskCount: number) => void;
  expandSelected: (tasks: Array<{ id: string }>) => void;
  closeDetail: () => void;
}

export function useTaskPanel(): UseTaskPanelReturn {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<TaskPanelMode>("list");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null);

  const open = useCallback(() => {
    setIsOpen(true);
    setMode("list");
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setMode("list");
    setDetailTaskId(null);
  }, []);

  const navigateUp = useCallback(() => {
    setSelectedIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const navigateDown = useCallback((taskCount: number) => {
    if (taskCount === 0) return;
    setSelectedIndex((prev) => Math.min(prev + 1, taskCount - 1));
  }, []);

  const expandSelected = useCallback((tasks: Array<{ id: string }>) => {
    const task = tasks[selectedIndex];
    if (task) {
      setDetailTaskId(task.id);
      setMode("detail");
    }
  }, [selectedIndex]);

  const closeDetail = useCallback(() => {
    if (mode === "detail") {
      setMode("list");
      setDetailTaskId(null);
    } else {
      close();
    }
  }, [mode, close]);

  return {
    isOpen,
    mode,
    selectedIndex,
    detailTaskId,
    open,
    close,
    navigateUp,
    navigateDown,
    expandSelected,
    closeDetail,
  };
}
