import request from '@/utils/request'

const urls = {
  sayHello: '/user',
  getUser: '/user/info'
}

export function sayHello(params) {
  return request({
    method: 'get',
    url: urls.sayHello,
    params: params
  })
}

export function getUser(params) {
  return request({
    method: 'get',
    url: urls.getUser,
    params: params
  })
}