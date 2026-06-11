import { Capacitor, registerPlugin } from '@capacitor/core'

// Bridge to the custom PeriodWidget Android plugin (see
// android/app/src/main/java/.../PeriodWidgetPlugin.java). Pushes the latest
// period data into SharedPreferences and refreshes the home-screen widget.
// The widget recomputes phase/cycle-day itself from these raw inputs, so we
// only need to feed it the start/end dates + resolved cycle length.

type PeriodWidgetPlugin = {
  update(data: {
    hasData: boolean
    startDate: string
    endDate: string | null
    cycleLength: number
  }): Promise<void>
}

const PeriodWidget = registerPlugin<PeriodWidgetPlugin>('PeriodWidget')

const isAvailable = (): boolean =>
  Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('PeriodWidget')

export const updatePeriodWidget = async (data: {
  startDate: string | null | undefined
  endDate: string | null | undefined
  cycleLength: number | null | undefined
}): Promise<void> => {
  if (!isAvailable()) return
  try {
    await PeriodWidget.update({
      hasData: !!data.startDate,
      startDate: data.startDate ?? '',
      endDate: data.endDate ?? null,
      cycleLength: data.cycleLength ?? 28,
    })
  } catch (err) {
    console.warn('update period widget failed', err)
  }
}
