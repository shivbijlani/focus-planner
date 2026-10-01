import profile from '#planner/deployment-profile'

if (profile.installPrompt && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}app-sw.js`)
}
