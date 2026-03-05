export const CtmTokenKey: string = 'Ctm-Token'
import { userInfoStore } from '@/store/index'
import { pinia } from '@/main'

const baseSso = import.meta.env.RENDERER_SSO
const currentUrl = location.href
export function getLoginUrl() {
  return baseSso + currentUrl
}
export function removeToken() {
  localStorage.removeItem('ctm-token')
  localStorage.removeItem('jms-token')
  localStorage.removeItem('bearer-token')
  localStorage.removeItem('userInfo')
  localStorage.removeItem('login-skipped')
}
export const setUserInfo = (info) => {
  const userStore = userInfoStore(pinia)
  userStore.updateInfo(info)
}
export const getUserInfo = () => {
  const userStore = userInfoStore(pinia)
  let userInfo = userStore.userInfo

  // If no user info from store, default to guest
  if (!userInfo || !userInfo.uid) {
    userInfo = {
      uid: 999999999,
      username: 'guest',
      name: 'Guest',
      email: 'guest@chaterm.ai',
      token: 'guest_token'
    }
  }

  return userInfo
}
