import { redis } from '../data-access/redis-connection'

const API_KEY = process.env.WEATHER_API_KEY
const TEN_MINUTES = 1000 * 60 * 10 // ms

const WEATHER_BASE_URL = 'https://api.openweathermap.org/data/2.5/weather'
const GEO_BASE_URL = 'http://api.openweathermap.org/geo/1.0/zip'

interface FetchWeatherDataParams {
  lat: number
  lon: number
  units: 'standard' | 'metric' | 'imperial'
}

export async function fetchWeatherData({ lat, lon, units }: FetchWeatherDataParams) {
  const queryKey = `weather:lat=${lat}&lon=${lon}&units=${units}`

  const cached = await redis.get(queryKey)
  if (cached) return JSON.parse(cached)

  const url = `${WEATHER_BASE_URL}?lat=${lat}&lon=${lon}&units=${units}&appid=${API_KEY}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OpenWeather weather request failed: ${response.status} ${response.statusText}`)
  }

  const dataText = await response.text()
  await redis.set(queryKey, dataText, { PX: TEN_MINUTES })
  return JSON.parse(dataText)
}

export async function getGeoCoordsForPostalCode(postalCode: string, countryCode: string) {
  const queryKey = `geo:zip=${postalCode},${countryCode}`

  const cached = await redis.get(queryKey)
  if (cached) return JSON.parse(cached)

  const url = `${GEO_BASE_URL}?zip=${encodeURIComponent(
    `${postalCode},${countryCode}`,
  )}&appid=${API_KEY}`
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`OpenWeather geo request failed: ${response.status} ${response.statusText}`)
  }

  const dataText = await response.text()
  await redis.set(queryKey, dataText, { PX: TEN_MINUTES })
  return JSON.parse(dataText)
}
