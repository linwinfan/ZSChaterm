import { spawn } from 'child_process'
import { platform } from 'process'

export interface RdpConnectionParams {
  host: string
  port?: number
  username?: string
  password?: string
  extraArgs?: string[]
}

export function buildRdpCommand(params: RdpConnectionParams): { cmd: string; args: string[] } {
  const { host, port = 3389, username, password, extraArgs } = params
  const target = `${host}:${port}`

  if (platform === 'win32') {
    // Windows: mstsc.exe /v:hostname:port
    // Note: mstsc does not directly support /u /p parameters, requires saved RDP file or credential manager
    const args = ['/v', target]
    if (extraArgs && extraArgs.length > 0) {
      args.push(...extraArgs)
    }
    return {
      cmd: 'mstsc.exe',
      args
    }
  } else if (platform === 'linux') {
    // Linux: xfreerdp /v:hostname:port [/u:username [/p:password]] [extra args]
    const args = [`/v:${target}`]
    if (username) {
      args.push(`/u:${username}`)
      if (password) {
        args.push(`/p:${password}`)
      }
    }
    if (extraArgs && extraArgs.length > 0) {
      args.push(...extraArgs)
    }
    return {
      cmd: 'xfreerdp',
      args
    }
  } else {
    throw new Error(`RDP not supported on platform: ${platform}`)
  }
}

export async function connectRdp(params: RdpConnectionParams): Promise<{ success: boolean; error?: string }> {
  try {
    const { cmd, args } = buildRdpCommand(params)
    console.log(`[RDP] Starting: ${cmd} ${args.join(' ')}`)

    // Launch process, detached: true makes it independent from main process
    const child = spawn(cmd, args, {
      detached: true,
      stdio: 'ignore'
    })

    child.unref()

    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[RDP] Connection failed: ${message}`)
    return { success: false, error: message }
  }
}

export async function checkRdpToolAvailability(): Promise<{ available: boolean; tool?: string; error?: string }> {
  const currentPlatform = platform

  if (currentPlatform === 'win32') {
    // Check if mstsc.exe exists
    const { execSync } = await import('child_process')
    try {
      execSync('where mstsc.exe', { stdio: 'pipe' })
      return { available: true, tool: 'mstsc.exe' }
    } catch {
      return { available: false, tool: 'mstsc.exe', error: 'mstsc.exe not found in PATH' }
    }
  } else if (currentPlatform === 'linux') {
    // Check if xfreerdp exists
    const { execSync } = await import('child_process')
    try {
      execSync('which xfreerdp', { stdio: 'pipe' })
      return { available: true, tool: 'xfreerdp' }
    } catch {
      return { available: false, tool: 'xfreerdp', error: 'xfreerdp not found in PATH' }
    }
  }

  return { available: false, error: `Unsupported platform: ${currentPlatform}` }
}
