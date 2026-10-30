# Android मोबाइल से BABA AI पर सुरक्षित काम

## GitHub
1. Repository खोलें: https://github.com/ck160143-prog/youtube-autopilot-agent
2. `feat/baba-business-os-foundation` branch में इस बदलाव की समीक्षा करें।
3. Files changed और diff देखें; किसी अनजान secret या unrelated deletion पर आगे न बढ़ें।
4. Pull request को review करें। इसे merge करने से पहले tests और production impact समझें।

## Render
1. Render Dashboard → existing service → Environment खोलें।
2. Secrets केवल Environment में रखें, GitHub file या chat में नहीं।
3. बिना समीक्षा के production environment variables न बदलें।
4. Deploy के बाद `/api/health` पर status जाँचें और logs में secret values न दिखाएँ।

## Termux (optional local test)
Node.js उपलब्ध होने पर repository clone करें, dependencies install करें, फिर `npm test` और `npm run build` चलाएँ। वास्तविक OAuth/AI परीक्षण के लिए वैध credentials आवश्यक हैं। Production secrets को साझा या commit न करें।

## सीमा
Free hosting पर sleep, temporary filesystem, request limits और provider quotas हो सकते हैं। महत्वपूर्ण CRM डेटा को केवल browser storage या process memory में न रखें।
