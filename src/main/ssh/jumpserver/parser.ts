// ssh2jumpserver/parser.ts

import type { JumpServerShellProfile } from './constants'
import { detectJumpServerShellProfile, hasNoAssetsPrompt } from './navigator'

export interface Asset {
  id: number
  name: string
  address: string
  platform: string
  organization: string
  comment: string
}

export interface MingyuAssetEntry extends Asset {
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

export interface ParsedOutput {
  assets: Asset[]
  pagination: PaginationInfo
  profile: JumpServerShellProfile | null
  recognized: boolean
}

export interface JumpServerUser {
  id: number
  name: string
  username: string
}

interface ParsedAssetsResult {
  assets: Asset[]
  recognized: boolean
}

const STANDARD_ASSET_REGEX = /^\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*$/
const MINGYU_ASSET_ENTRY_REGEX = /(?:^|[\s\r\n])(\d{1,4}):\s*([\s\S]*?)(?=(?:\s+\d{1,4}:\s)|(?:\s+\/\s*\d+\s*,)|$)/g
const CHINESE_PAGINATION_REGEX = /页码：\s*(\d+).*?总页数：\s*(\d+)/
const ENGLISH_PAGINATION_REGEX = /Page:\s*(\d+).*?Total Page:\s*(\d+)/
const MINGYU_PAGINATION_REGEX = /(?:^|[\s\r\n])\/\s*(\d+)\s*,/m

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

const isStandardAssetHeaderLine = (line: string): boolean => {
  const upperLine = line.toUpperCase()

  if (line.includes('ID') && (line.includes('名称') || line.includes('地址'))) {
    return true
  }

  return upperLine.includes('ID') && upperLine.includes('ADDRESS') && !upperLine.includes('USERNAME')
}

const isStandardAssetSeparatorLine = (line: string): boolean => {
  return line.includes('-----+--')
}

function parseStandardAssets(output: string): ParsedAssetsResult {
  const assets: Asset[] = []
  const lines = output.split('\n')

  let foundAssetHeader = false
  let recognized = false

  for (const line of lines) {
    if (!foundAssetHeader) {
      if (isStandardAssetHeaderLine(line)) {
        foundAssetHeader = true
        recognized = true
        continue
      }

      if (isStandardAssetSeparatorLine(line)) {
        foundAssetHeader = true
        continue
      }
    }

    if (!foundAssetHeader) {
      continue
    }

    const match = line.match(STANDARD_ASSET_REGEX)
    if (!match) {
      continue
    }

    try {
      const asset: Asset = {
        id: parseInt(match[1].trim(), 10),
        name: match[2].trim(),
        address: match[3].trim(),
        platform: match[4].trim(),
        organization: match[5].trim(),
        comment: match[6].trim()
      }
      assets.push(asset)
      recognized = true
    } catch (error) {
      console.error('Failed to parse standard JumpServer asset line:', line, error)
    }
  }

  return { assets, recognized }
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
      console.error('Failed to parse Mingyu asset line:', match[0], error)
    }
  }

  return entries
}

function parseMingyuAssets(output: string): ParsedAssetsResult {
  const entries = parseMingyuAssetEntries(output)
  return {
    assets: entries.map(({ selector: _selector, endpoint: _endpoint, protocol: _protocol, loginUser: _loginUser, group: _group, ...asset }) => asset),
    recognized: entries.length > 0
  }
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

function parsePagination(output: string): PaginationInfo {
  const chineseMatch = output.match(CHINESE_PAGINATION_REGEX)
  if (chineseMatch) {
    return {
      currentPage: parseInt(chineseMatch[1], 10),
      totalPages: parseInt(chineseMatch[2], 10)
    }
  }

  const englishMatch = output.match(ENGLISH_PAGINATION_REGEX)
  if (englishMatch) {
    return {
      currentPage: parseInt(englishMatch[1], 10),
      totalPages: parseInt(englishMatch[2], 10)
    }
  }

  const mingyuMatch = output.match(MINGYU_PAGINATION_REGEX)
  if (mingyuMatch) {
    return {
      currentPage: 1,
      totalPages: parseInt(mingyuMatch[1], 10)
    }
  }

  return { currentPage: 1, totalPages: 1 }
}

const hasRecognizedPagination = (output: string): boolean => {
  return CHINESE_PAGINATION_REGEX.test(output) || ENGLISH_PAGINATION_REGEX.test(output) || MINGYU_PAGINATION_REGEX.test(output)
}

/**
 * Parse JumpServer raw output.
 * @param output JumpServer shell raw output string
 * @returns Parsed assets and pagination information
 */
export function parseJumpserverOutput(output: string): ParsedOutput {
  const profile = detectJumpServerShellProfile(output)
  const standardResult = parseStandardAssets(output)
  const mingyuResult = parseMingyuAssets(output)
  const assets =
    profile === 'mingyu'
      ? mingyuResult.assets
      : standardResult.assets.length > 0 || standardResult.recognized
        ? standardResult.assets
        : mingyuResult.assets
  const pagination = parsePagination(output)
  const recognized = standardResult.recognized || mingyuResult.recognized || hasRecognizedPagination(output) || hasNoAssetsPrompt(output)

  return { assets, pagination, profile, recognized }
}

/**
 * Parse JumpServer user list from output.
 * @param output JumpServer shell output containing user table
 * @returns Array of parsed users
 */
export function parseJumpServerUsers(output: string): JumpServerUser[] {
  const users: JumpServerUser[] = []
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
          const user: JumpServerUser = {
            id: parseInt(match[1].trim(), 10),
            name: match[2].trim(),
            username: match[3].trim()
          }
          users.push(user)
        } catch (error) {
          console.error('Failed to parse user line:', line, error)
        }
      }
    }
  }

  return users
}

/**
 * Detect if output contains user selection prompt.
 * @param output JumpServer shell output
 * @returns true if user selection is required
 */
export function hasUserSelectionPrompt(output: string): boolean {
  return output.includes('account ID') && output.includes('ID') && output.includes('NAME') && output.includes('USERNAME')
}
