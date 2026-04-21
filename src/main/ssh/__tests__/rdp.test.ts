import { describe, expect, it } from 'vitest'
import { buildRdpCommand } from '../rdp'

describe('rdp', () => {
  describe('buildRdpCommand', () => {
    it('builds xfreerdp command for linux without credentials', () => {
      const result = buildRdpCommand({ host: '192.168.1.100' })
      expect(result.cmd).toBe('xfreerdp')
      expect(result.args).toEqual(['/v:192.168.1.100:3389'])
    })

    it('builds xfreerdp command for linux with credentials', () => {
      const result = buildRdpCommand({
        host: '192.168.1.100',
        port: 3390,
        username: 'admin',
        password: 'secret'
      })
      expect(result.cmd).toBe('xfreerdp')
      expect(result.args).toEqual(['/v:192.168.1.100:3390', '/u:admin', '/p:secret'])
    })

    it('builds xfreerdp command for linux with username only', () => {
      const result = buildRdpCommand({
        host: '192.168.1.100',
        username: 'admin'
      })
      expect(result.cmd).toBe('xfreerdp')
      expect(result.args).toEqual(['/v:192.168.1.100:3389', '/u:admin'])
    })

    it('uses default port 3389', () => {
      const result = buildRdpCommand({ host: '192.168.1.100' })
      expect(result.args).toContain('/v:192.168.1.100:3389')
    })

    it('builds mstsc command for windows', () => {
      // Only test on Windows
      if (process.platform !== 'win32') return
      const result = buildRdpCommand({
        host: '192.168.1.100',
        port: 3389,
        username: 'admin',
        password: 'secret'
      })
      expect(result.cmd).toBe('mstsc.exe')
      expect(result.args).toEqual(['/v', '192.168.1.100:3389'])
    })

    it('throws error for unsupported platform', () => {
      // This test only works on non-linux/non-win platforms
      // On actual linux/win, platform is supported so it won't throw
      if (process.platform !== 'linux' && process.platform !== 'win32') {
        expect(() => buildRdpCommand({ host: '192.168.1.100' })).toThrow(/not supported/)
      }
    })
  })
})
