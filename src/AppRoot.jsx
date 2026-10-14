import { DefaultHostProvider } from '#planner/host-provider'
import App from './App.jsx'

export function AppRoot({ children = <App /> }) {
  return <DefaultHostProvider>{children}</DefaultHostProvider>
}
