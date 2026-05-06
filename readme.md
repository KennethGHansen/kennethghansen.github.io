This repository, right now, just functions as a backup for the actual weather station frontend code. I am using CloudFlare for the actual frontend architecture.

Status: 16-04-2026
The weather-station is up and running and have been initially polished for pleasent UI experience. More work on this to come. I am using Tailwind CSS for the layout.

Status: 24/04-2026
The weather-station is now running with both indoor and outdoor (Shelly sensor) temperature and humidity live update. Also the Shelly battery warning is implemented at 25 % battery
when it is time to change it.

Status: 06/05-2026
The frontend is now running with both live 3 sec update and also history updates 6h: every 5 minutes, 24h: every 10 minutes, 7d, every hour. I had some problems with hitting the durable objects
reqest limit of 100k (Cloudflare free subscription). By changing the history to only fetching every 5 minutes helped alot on the history DO
The live DO updates every 3 seconds so that is the limiting factor, but we will see if it becomes a problem with more viewers (There is a ~50k static load that i dont know where comes from on the live DO)
So, we are running now, but I will be evaluating the request to see if we perhaps need to lower the live sample rate.

https://weather-station.kghansen123.workers.dev/

Instruction for deploying new code:
- Install Wrangler newest version
- Open cmd in directory
- Run: 'npx wrangler deploy'
(You need to have the correct frontend architecture running in ex. Cloudflare)