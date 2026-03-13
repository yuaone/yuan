/**
 * TaskPanel — background agent task list + step detail viewer.
 *
 * Layout modes:
 *   LIST  — shows all bg tasks with ▸ cursor, ↑↓ navigate, enter expand, esc close
 *   DETAIL — shows selected task's step tree, esc → back to list
 *
 * Opens below InputBox. Matches input container width.
 * Truncates long labels with "…". Max 8 rows visible at a time.
 */

import React from "react";
import { Box, Text } from "ink";
import { TOKENS } from "../lib/tokens.js";
import type { TUIBackgroundTask, TUIBGStep } from "../types.js";

export type TaskPanelMode = "list" | "detail";

export interface TaskPanelProps {
  tasks: TUIBackgroundTask[];
  mode: TaskPanelMode;
  selectedIndex: number;
  /** Task being viewed in detail mode (by id) */
  detailTaskId: string | null;
  width: number;
}

const MAX_LIST_ROWS = 6;
const MAX_DETAIL_ROWS = 8;
const LABEL_MAX = 26;
const MSG_MAX = 38;

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** Status icon + color for a task */
function taskIcon(task: TUIBackgroundTask): { icon: string; color: string } {
  switch (task.status) {
    case "running": return { icon: "●", color: "yellow" };
    case "error":   return { icon: "✗", color: "red" };
    default:        return { icon: "○", color: "#555555" };
  }
}

/** Step icon for detail tree */
function stepIcon(step: TUIBGStep): { icon: string; color: string } {
  switch (step.type) {
    case "success": return { icon: "✓", color: "#3a7d44" };
    case "error":   return { icon: "✗", color: "red" };
    case "warning": return { icon: "⚠", color: "yellow" };
    default:        return { icon: "·", color: "#555555" };
  }
}

function TaskListView({
  tasks,
  selectedIndex,
  width,
}: {
  tasks: TUIBackgroundTask[];
  selectedIndex: number;
  width: number;
}): React.JSX.Element {
  const divider = TOKENS.box.horizontal.repeat(Math.max(0, width - 1));
  const B = TOKENS.box;

  // Visible window around selected
  const start = Math.max(0, Math.min(selectedIndex - 2, tasks.length - MAX_LIST_ROWS));
  const visible = tasks.slice(start, start + MAX_LIST_ROWS);
  const hasAbove = start > 0;
  const hasBelow = start + MAX_LIST_ROWS < tasks.length;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Top border + header */}
      <Text dimColor>{divider}</Text>
      <Box justifyContent="space-between">
        <Text dimColor>  bg agents ({tasks.length})</Text>
        <Text dimColor>↑↓ nav  enter expand  esc close  </Text>
      </Box>

      {/* Task rows */}
      {hasAbove && <Text dimColor>  ↑ {start} more</Text>}
      {visible.map((task, i) => {
        const absIdx = start + i;
        const isSelected = absIdx === selectedIndex;
        const { icon, color } = taskIcon(task);
        const label = truncate(task.label, LABEL_MAX);
        const lastStep = task.steps[task.steps.length - 1];
        const lastMsg = lastStep ? truncate(lastStep.label, MSG_MAX) : "";
        return (
          <Box key={task.id}>
            <Text color={isSelected ? "white" : "#444444"}>{isSelected ? "▸ " : "  "}</Text>
            <Text color={color}>{icon}</Text>
            <Text color={isSelected ? "white" : "#888888"}> {label.padEnd(LABEL_MAX)}</Text>
            <Text dimColor>  {lastMsg}</Text>
          </Box>
        );
      })}
      {hasBelow && <Text dimColor>  ↓ {tasks.length - start - MAX_LIST_ROWS} more</Text>}
    </Box>
  );
}

function TaskDetailView({
  task,
  width,
}: {
  task: TUIBackgroundTask;
  width: number;
}): React.JSX.Element {
  const divider = TOKENS.box.horizontal.repeat(Math.max(0, width - 1));
  const { icon, color } = taskIcon(task);

  // Show last MAX_DETAIL_ROWS steps
  const steps = task.steps.slice(-MAX_DETAIL_ROWS);
  const truncatedCount = task.steps.length - steps.length;

  return (
    <Box flexDirection="column" flexShrink={0}>
      {/* Top border + task header */}
      <Text dimColor>{divider}</Text>
      <Box justifyContent="space-between">
        <Box>
          <Text color={color}>  {icon}</Text>
          <Text color="white"> {task.label}</Text>
        </Box>
        <Text dimColor>esc back  </Text>
      </Box>
      <Text dimColor>  {divider.slice(0, Math.max(0, width - 3))}</Text>

      {/* Step tree */}
      {truncatedCount > 0 && (
        <Text dimColor>  … {truncatedCount} earlier step{truncatedCount === 1 ? "" : "s"}</Text>
      )}
      {steps.map((step, i) => {
        const isLast = i === steps.length - 1;
        const connector = isLast ? TOKENS.tree.last : TOKENS.tree.branch;
        const { icon: sIcon, color: sColor } = stepIcon(step);
        const label = truncate(step.label, width - 10);
        return (
          <Box key={step.id} paddingLeft={2}>
            <Text dimColor>{connector}</Text>
            <Text color={sColor}> {sIcon}</Text>
            <Text dimColor> {label}</Text>
          </Box>
        );
      })}
      {steps.length === 0 && (
        <Box paddingLeft={4}>
          <Text dimColor>no events yet</Text>
        </Box>
      )}
    </Box>
  );
}

export function TaskPanel({
  tasks,
  mode,
  selectedIndex,
  detailTaskId,
  width,
}: TaskPanelProps): React.JSX.Element {
  if (tasks.length === 0) return <Box />;

  if (mode === "detail" && detailTaskId) {
    const task = tasks.find((t) => t.id === detailTaskId);
    if (task) {
      return <TaskDetailView task={task} width={width} />;
    }
  }

  return <TaskListView tasks={tasks} selectedIndex={selectedIndex} width={width} />;
}
