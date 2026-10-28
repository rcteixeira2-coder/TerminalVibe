import { launch, command, sleep } from './lib.mjs'
import { startFakeOpenAI } from '../fixtures/fakeLLM.mjs'
const fake = await startFakeOpenAI()
const { app, page, close, errors } = await launch({ env: { COCKPIT_AGENT_TEST_BASEURL: JSON.stringify({ xai: fake.url }) } })
console.log('antes', JSON.stringify(await page.evaluate(() => window.cockpit.invoke('agent:providers'))).slice(0, 300))
console.log('setKey', JSON.stringify(await page.evaluate(() => window.cockpit.invoke('agent:setKey', 'xai', 'xai-teste'))))
console.log('depois', JSON.stringify((await page.evaluate(() => window.cockpit.invoke('agent:providers'))).providers[0]))
console.log('errors', errors.filter((e) => !/deprecated|Debugger/.test(e)))
await close(); fake.server.close()
