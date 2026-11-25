// 测试用的假宿主：真的监听一个端口，用来验证「杀掉旧进程 → 启动 → 等到端口」这条链路。
import { createServer } from 'node:http'
import { writeFileSync } from 'node:fs'

const portFile = process.argv[2] || 'port.txt'
const server = createServer((req, res) => { res.statusCode = 401; res.end('nope') })
server.listen(0, '127.0.0.1', () => {
  const port = server.address().port
  try { writeFileSync(portFile, String(port), 'utf8') } catch { /* ignore */ }
  console.log(`fake-host listening on ${port}`)
})
// 活得比测试久一点
setTimeout(() => process.exit(0), 10 * 60_000)
