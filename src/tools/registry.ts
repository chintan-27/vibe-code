import { askUserTool } from './ask.ts'
import { astEditTool } from './astedit.ts'
import { bashTool } from './bash.ts'
import { editTool } from './edit.ts'
import { globTool } from './glob.ts'
import { grepTool } from './grep.ts'
import { readTool } from './read.ts'
import { taskTool } from './task.ts'
import { todoWriteTool } from './todo.ts'
import type { AnyTool } from './types.ts'
import { webFetchTool } from './webfetch.ts'
import { webSearchTool } from './websearch.ts'
import { writeTool } from './write.ts'

export const coreTools = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  todoWriteTool,
  taskTool,
  askUserTool,
  astEditTool,
  webFetchTool,
  webSearchTool,
] satisfies AnyTool[]

export function toolMap(tools: AnyTool[] = coreTools): Map<string, AnyTool> {
  return new Map(tools.map(tool => [tool.name, tool]))
}
