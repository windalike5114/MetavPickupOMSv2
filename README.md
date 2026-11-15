<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/7a0e01a1-0c8f-43cc-b36a-34673243d765

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set `JWT_SECRET` in `.env.local` to a private, randomly generated value. Generate one with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`. Set `GEMINI_API_KEY` in the same file if you use Gemini.
3. Run the app:
   `npm run dev`

Set `JWT_SECRET` in the server environment before deploying and use the same value across replicas. Configure a fresh secret for any deployment that previously relied on the built-in default. Changing the secret requires users to sign in again.

## Deploy the China portal

Deploy and verify `cn.acapickup.com` first, including `/cn/login` and authenticated order pages. Then deploy the main service so requests such as `acapickup.com/cn/orders` redirect to the same path on `cn.acapickup.com`. Users with a session on the main domain will need to sign in on the China domain.
