/**
 * Tool registry — aggregates all available tools.
 *
 * Tools are split into core (always fully loaded) and extended (deferred).
 * Deferred tools contribute only a one-liner to the system prompt until
 * activated via ToolSearch or first invocation.
 */

import type { Tools } from "./Tool.js";
import { DeferredTool } from "./DeferredTool.js";

// Core tools — always fully loaded with complete prompts
import { BashTool } from "./tools/BashTool/index.js";
import { FileReadTool } from "./tools/FileReadTool/index.js";
import { FileWriteTool } from "./tools/FileWriteTool/index.js";
import { FileEditTool } from "./tools/FileEditTool/index.js";
import { GlobTool } from "./tools/GlobTool/index.js";
import { GrepTool } from "./tools/GrepTool/index.js";
import { LSTool } from "./tools/LSTool/index.js";
import { AskUserTool } from "./tools/AskUserTool/index.js";
import { AgentTool } from "./tools/AgentTool/index.js";
import { TaskCreateTool } from "./tools/TaskCreateTool/index.js";
import { TaskUpdateTool } from "./tools/TaskUpdateTool/index.js";
import { TaskListTool } from "./tools/TaskListTool/index.js";
import { EnterPlanModeTool } from "./tools/EnterPlanModeTool/index.js";
import { ExitPlanModeTool } from "./tools/ExitPlanModeTool/index.js";
import { ToolSearchTool } from "./tools/ToolSearchTool/index.js";
import { MemoryTool } from "./tools/MemoryTool/index.js";
import { ImageReadTool } from "./tools/ImageReadTool/index.js";

// Extended tools — deferred loading (minimal prompt until first use)
import { WebFetchTool } from "./tools/WebFetchTool/index.js";
import { WebSearchTool } from "./tools/WebSearchTool/index.js";
import { TaskGetTool } from "./tools/TaskGetTool/index.js";
import { TaskStopTool } from "./tools/TaskStopTool/index.js";
import { TaskOutputTool } from "./tools/TaskOutputTool/index.js";
import { SkillTool } from "./tools/SkillTool/index.js";
import { NotebookEditTool } from "./tools/NotebookEditTool/index.js";
import { DiagnosticsTool } from "./tools/DiagnosticsTool/index.js";
import { ParallelAgentTool } from "./tools/ParallelAgentTool/index.js";
import { SendMessageTool } from "./tools/SendMessageTool/index.js";
import { CronCreateTool, CronDeleteTool, CronListTool } from "./tools/CronTool/index.js";
import { EnterWorktreeTool } from "./tools/EnterWorktreeTool/index.js";
import { ExitWorktreeTool } from "./tools/ExitWorktreeTool/index.js";
import { KillProcessTool } from "./tools/KillProcessTool/index.js";
import { RemoteTriggerTool } from "./tools/RemoteTriggerTool/index.js";
import { MultiEditTool } from "./tools/MultiEditTool/index.js";
import { PipelineTool } from "./tools/PipelineTool/index.js";
import { PowerShellTool } from "./tools/PowerShellTool/index.js";
import { MonitorTool } from "./tools/MonitorTool/index.js";

/**
 * Returns all registered tools.
 *
 * Core tools (~17) are fully loaded with complete prompts.
 * Extended tools (~18) are deferred — they show a one-liner in the system
 * prompt and resolve full schema on first use or via ToolSearch.
 */
export function getAllTools(): Tools {
  const core: Tools = [
    // File operations
    BashTool,
    FileReadTool,
    ImageReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    LSTool,
    // Agent interaction
    AskUserTool,
    AgentTool,
    // Task management
    TaskCreateTool,
    TaskUpdateTool,
    TaskListTool,
    // Planning
    EnterPlanModeTool,
    ExitPlanModeTool,
    // Tool Discovery
    ToolSearchTool,
    // Pipelines
    PipelineTool,
    // Memory management
    MemoryTool,
  ];

  const extended: Tools = [
    WebFetchTool,
    WebSearchTool,
    TaskGetTool,
    TaskStopTool,
    TaskOutputTool,
    SkillTool,
    NotebookEditTool,
    DiagnosticsTool,
    ParallelAgentTool,
    SendMessageTool,
    CronCreateTool,
    CronDeleteTool,
    CronListTool,
    EnterWorktreeTool,
    ExitWorktreeTool,
    KillProcessTool,
    RemoteTriggerTool,
    MultiEditTool,
    PowerShellTool,
    MonitorTool,
  ];

  return [
    ...core,
    ...extended.map(t => new DeferredTool(t)),
  ];
}
