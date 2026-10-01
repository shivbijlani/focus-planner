import { createContext, useContext } from 'react'

const HostContext = createContext({ identity: null, kind: 'consumer-web' })

export function DefaultHostProvider({ children }) {
  return <HostContext.Provider value={{ identity: null, kind: 'consumer-web' }}>{children}</HostContext.Provider>
}

export function useHost() {
  return useContext(HostContext)
}
