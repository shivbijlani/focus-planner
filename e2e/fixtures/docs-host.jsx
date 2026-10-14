import React, { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '#planner/storage-bootstrap'
import DocsApp from '../../src/docs-app/DocsApp.jsx'
import { bootStorage } from '../../src/docs-app/storageBoot.js'
import { draftKey } from '../../src/docs-app/docsStore.js'
import * as storage from '../../src/storage/storage.js'
import '../../src/docs-app/docs.css'
import { SAMPLE_DOC_FILES, SAMPLE_PRIMARY_ID } from './docs-sample.js'

await bootStorage()
for (const [name, content] of Object.entries(SAMPLE_DOC_FILES)) await storage.write(name, content)
window.location.hash = `#/d/${SAMPLE_PRIMARY_ID}`

export default function Fixture() {
  const [scope, setScope] = useState({ accountId: 'account-a', sourceId: 'source-a' })
  const [fail, setFail] = useState(false)
  const boot = useCallback(() => {
    if (fail) throw new Error('Managed host boot refused')
    return { hasSources: true, activeId: scope.sourceId, draftScope: scope }
  }, [scope, fail])
  window.docsFixture = { setScope, setFail, draftKey, docId: SAMPLE_PRIMARY_ID }
  return <DocsApp sessionKey={JSON.stringify([scope, fail])} bootStorage={boot} />
}

createRoot(document.getElementById('root')).render(<Fixture />)
