const pad = (value: number) => value.toString().padStart(2, '0')

const formatOffset = (offsetMinutes: number) => {
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absoluteMinutes = Math.abs(offsetMinutes)
  const hours = pad(Math.floor(absoluteMinutes / 60))
  const minutes = pad(absoluteMinutes % 60)
  return `${sign}${hours}:${minutes}`
}

export const formatLocalTimestamp = (isoString: string) => {
  const date = new Date(isoString)
  if (Number.isNaN(date.getTime())) {
    return '1970-01-01 00:00 +00:00'
  }

  const year = date.getFullYear()
  const month = pad(date.getMonth() + 1)
  const day = pad(date.getDate())
  const hours = pad(date.getHours())
  const minutes = pad(date.getMinutes())
  const offset = formatOffset(-date.getTimezoneOffset())

  return `${year}-${month}-${day} ${hours}:${minutes} ${offset}`
}

export const withTimePrefix = (text: string, isoString: string) =>
  `[${formatLocalTimestamp(isoString)}] ${text}`

// 把"北京时间的钟点"换算成"从现在起多少分钟后"，给定时工具用（免得模型
// 自己做时间减法出错）。中国固定 UTC+8、无夏令时，所以直接拼 +08:00 解析。
// 接受两种写法：
//   "HH:MM"            → 今天该钟点；已过则顺延到明天（"叫我8点起床"）
//   "YYYY-MM-DD HH:MM" → 指定日期钟点
// 返回四舍五入的分钟数（可能为负=已过去）；无法解析返回 null。
export const chinaClockToDelayMinutes = (atTime: string): number | null => {
  const s = atTime.trim()
  let epoch = NaN
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/.exec(s)
  if (m) {
    epoch = Date.parse(`${m[1]}-${pad(+m[2])}-${pad(+m[3])}T${pad(+m[4])}:${m[5]}:00+08:00`)
  } else {
    m = /^(\d{1,2}):(\d{2})$/.exec(s)
    if (m) {
      const todayCN = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date())
      epoch = Date.parse(`${todayCN}T${pad(+m[1])}:${m[2]}:00+08:00`)
      if (!Number.isNaN(epoch) && epoch <= Date.now()) epoch += 86400_000 // 已过 → 明天
    }
  }
  if (Number.isNaN(epoch)) return null
  return Math.round((epoch - Date.now()) / 60000)
}
