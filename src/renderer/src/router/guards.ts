import { dataSyncService } from '@/services/dataSyncService'

export const beforeEach = async (to, _from, next) => {
  // Set up guest user automatically
  localStorage.removeItem('login-skipped')
  localStorage.removeItem('ctm-token')
  localStorage.removeItem('jms-token')
  localStorage.removeItem('userInfo')

  localStorage.setItem('login-skipped', 'true')
  localStorage.setItem('ctm-token', 'guest_token')

  const guestUserInfo = {
    uid: 999999999,
    username: 'guest',
    name: 'Guest',
    email: 'guest@chaterm.ai',
    token: 'guest_token'
  }

  // Set user info
  const userInfoStr = JSON.stringify(guestUserInfo)
  localStorage.setItem('userInfo', userInfoStr)
  localStorage.setItem('user-info', userInfoStr) // For compatibility in permission utils

  try {
    // Initialize database with guest UID
    const api = (window as any).api
    const dbResult = await api.initUserDatabase({ uid: 999999999 })

    if (dbResult.success) {
      // After database initialization succeeds, asynchronously initialize data sync service
      dataSyncService.initialize().catch((error) => {
        console.error('Data sync service initialization failed:', error)
      })
      next()
    } else {
      console.error('Database initialization failed')
      next('/')
    }
  } catch (error) {
    console.error('Initialization failed:', error)
    next('/')
  }
}

export const afterEach = () => {}
