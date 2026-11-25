// 测试用的假 pnpm：只记一笔，不真装。
import { appendFileSync } from 'node:fs'

const mark = process.env.DOCTOR_TEST_MARK
if (mark) appendFileSync(mark, `pnpm ${process.argv.slice(2).join(' ')}\n`)
process.exit(0)
