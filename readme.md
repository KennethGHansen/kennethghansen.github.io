This repository, right now, just functions as a backup for the actual weather station frontend code. I am using CloudFlare for the actual frontend architecture.

Status: 16-04-2026
The weather-station is up and running and have been initially polished for pleasent UI experience. More work on this to come. I am using Tailwind CSS for the layout.

Status: 24/04-2026
The weather-station is now running with both indoor and outdoor (Shelly sensor) temperature and humidity live update. Also the Shelly battery warning is implemented at 25 % battery
when it is time to change it.

https://weather-station.kghansen123.workers.dev/

Instruction for deploying new code:
- Install Wrangler newest version
- Open cmd in directory
- Run: 'npx wrangler deploy'
(You need to have the correct frontend architecture running in ex. Cloudflare)