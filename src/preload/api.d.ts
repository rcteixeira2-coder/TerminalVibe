import type { CockpitApi } from './index'

declare global {
  interface Window {
    cockpit: CockpitApi
  }
}

export {}
