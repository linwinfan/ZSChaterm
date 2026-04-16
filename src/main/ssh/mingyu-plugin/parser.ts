/**
 * Mingyu Parser - 解析 Mingyu 堡垒机菜单输出
 * 从 jumpserver/parser.ts 复制并解耦
 */

export interface MingyuAssetEntry {
  id: number
  name: string
  address: string
  platform: string
  organization: string
  comment: string
  selector: string
  endpoint: string
  protocol: string
  loginUser: string
  group: string
}

export interface MingyuTargetMatch {
  entry: MingyuAssetEntry
  matchField: 'address' | 'hostname' | 'asset'
  selectionCommands: string[]
}

export type MingyuTargetResolution =
  | {
      status: 'matched'
      match: MingyuTargetMatch
    }
  | {
      status: 'not_found' | 'ambiguous'
      entries: MingyuAssetEntry[]
    }

export interface PaginationInfo {
  currentPage: number
  totalPages: number
}

const MINGYU_ASSET_ENTRY_REGEX = /(?:^|[\s\r\n])(\d{1,4}):\s*([\s\S]*?)(?=(?:\s+\d{1,4}:\s)|(?:\s+\/\s*\d+\s*,)|$)/g

const normalizeValue = (value?: string): string => value?.trim().toLowerCase() || ''

export const MINGYU_ENTER_SELECTION_COMMAND = '__ENTER__'

export const normalizeMingyuLoginUser = (value?: string): string => {
  const normalized = normalizeValue(value)
  return normalized === '[empty]' ? '' : normalized
}

const uniqueCommands = (commands: string[]): string[] => {
  const normalizedCommands = commands.map((command) => command.trim()).filter(Boolean)
  const seen = new Set<string>()
  const result: string[] = []

  for (const command of normalizedCommands) {
    if (command === MINGYU_ENTER_SELECTION_COMMAND) {
      result.push(command)
      continue
    }

    if (seen.has(command)) {
      continue
    }

    seen.add(command)
    result.push(command)
  }

  return result
}

const buildMingyuSelectionCommands = (entry: MingyuAssetEntry): string[] => {
  const loginUser = normalizeMingyuLoginUser(entry.loginUser)
  if (loginUser) {
    // Use :ssh user@host:port which has correct server-side routing
    return [`:ssh ${loginUser}@${entry.endpoint}`]
  }
  // Fallback to original selection method when loginUser is [EMPTY]
  const numericSelector = String(entry.id)
  return uniqueCommands([`:${numericSelector}`, MINGYU_ENTER_SELECTION_COMMAND, `open ${entry.selector}`])
}

/**
 * Build arrow key navigation command to move cursor to target line
 * Add extra j presses to ensure we land on the correct line
 * @param targetLine - The line number to navigate to (1-based)
 * @returns Arrow key commands string followed by enter
 */
export const buildMingyuArrowNavigationCommands = (targetLine: number): string => {
  if (targetLine <= 0) {
    return ''
  }
  // targetLine=1: send two j's to move from header/focus to first asset
  // targetLine>1: move (targetLine - 1) lines down, plus 2 extra for header/focus compensation
  const downPresses = targetLine === 1 ? 2 : targetLine - 1 + 2
  return 'j'.repeat(downPresses)
}

export function parseMingyuAssetEntries(output: string): MingyuAssetEntry[] {
  const entries: MingyuAssetEntry[] = []

  for (const match of output.matchAll(MINGYU_ASSET_ENTRY_REGEX)) {
    const columns = match[2]
      .trim()
      .split(/\s{2,}/)
      .map((column) => column.trim())
      .filter(Boolean)

    if (columns.length < 2) {
      continue
    }

    const [name, endpoint, protocol = 'ssh', loginUser = '', ...restColumns] = columns
    if (!/:\d+$/.test(endpoint)) {
      continue
    }

    const address = endpoint.replace(/:\d+$/, '')

    try {
      entries.push({
        selector: match[1],
        id: parseInt(match[1], 10),
        name,
        address,
        endpoint,
        platform: protocol,
        protocol,
        organization: '',
        comment: '',
        loginUser,
        group: restColumns.join(' ')
      })
    } catch (error) {
      console.error('[Mingyu-parser] Failed to parse Mingyu asset line:', match[0], error)
    }
  }

  return entries
}

export function resolveMingyuTargetSelection(
  output: string,
  target: {
    targetIp: string
    targetHostname?: string
    targetAsset?: string
  }
): MingyuTargetResolution {
  const entries = parseMingyuAssetEntries(output)
  const normalizedTargetIp = normalizeValue(target.targetIp)
  const normalizedTargetHostname = normalizeValue(target.targetHostname)
  const normalizedTargetAsset = normalizeValue(target.targetAsset)

  let candidates = entries.filter((entry) => normalizeValue(entry.address) === normalizedTargetIp)
  if (candidates.length === 0) {
    return { status: 'not_found', entries }
  }

  let matchField: 'address' | 'hostname' | 'asset' = 'address'

  if (candidates.length > 1 && normalizedTargetHostname) {
    const hostnameMatches = candidates.filter((entry) => normalizeValue(entry.name) === normalizedTargetHostname)
    if (hostnameMatches.length > 0) {
      candidates = hostnameMatches
      matchField = 'hostname'
    }
  }

  if (candidates.length > 1 && normalizedTargetAsset) {
    const assetMatches = candidates.filter((entry) => {
      const comparableFields = [entry.name, entry.address, entry.endpoint, entry.selector, entry.group, entry.comment]
      return comparableFields.some((field) => {
        const normalizedField = normalizeValue(field)
        return normalizedField === normalizedTargetAsset || (normalizedTargetAsset.length > 3 && normalizedField.includes(normalizedTargetAsset))
      })
    })
    if (assetMatches.length > 0) {
      candidates = assetMatches
      matchField = 'asset'
    }
  }

  if (candidates.length !== 1) {
    return { status: 'ambiguous', entries: candidates }
  }

  return {
    status: 'matched',
    match: {
      entry: candidates[0],
      matchField,
      selectionCommands: buildMingyuSelectionCommands(candidates[0])
    }
  }
}

/**
 * Detect if output contains user selection prompt.
 * @param output Mingyu shell output
 * @returns true if user selection is required
 */
export function hasUserSelectionPrompt(output: string): boolean {
  return output.includes('account ID') && output.includes('ID') && output.includes('NAME') && output.includes('USERNAME')
}

export interface MingyuUser {
  id: number
  name: string
  username: string
}

/**
 * Parse Mingyu user list from output.
 * @param output Mingyu shell output containing user table
 * @returns Array of parsed users
 */
export function parseMingyuUsers(output: string): MingyuUser[] {
  const users: MingyuUser[] = []
  const lines = output.split('\n')
  const userRegex = /^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*$/

  let foundUserHeader = false

  for (const line of lines) {
    if (line.includes('ID') && line.includes('NAME') && line.includes('USERNAME')) {
      foundUserHeader = true
      continue
    }

    if (line.includes('---+---')) {
      continue
    }

    if (foundUserHeader) {
      if (line.includes('Tips:') || line.includes('Back:') || line.includes('ID>')) {
        break
      }

      const match = line.match(userRegex)
      if (match) {
        try {
          const user: MingyuUser = {
            id: parseInt(match[1].trim(), 10),
            name: match[2].trim(),
            username: match[3].trim()
          }
          users.push(user)
        } catch (error) {
          console.error('[Mingyu-parser] Failed to parse user line:', line, error)
        }
      }
    }
  }

  return users
}
