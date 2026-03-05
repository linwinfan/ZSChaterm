import Home from '@/views/index.vue'

export const AppRoutes = [
  {
    path: '/',
    name: 'Home',
    meta: {
      requiresAuth: false  // Change to not require auth since we're always guest
    },
    component: Home
  },
  {
    path: '/:pathMatch(.*)*',  // Catch-all for invalid paths
    redirect: '/'
  }
]
