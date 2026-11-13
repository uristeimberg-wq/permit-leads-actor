# Chromium is required: the Accela sources are ASP.NET postback portals that
# cannot be read with a plain fetch. This base image ships a matching browser.
FROM apify/actor-node-playwright-chrome:20

COPY --chown=myuser:myuser package*.json ./

RUN npm --quiet set progress=false \
 && npm install --omit=dev --omit=optional \
 && echo "Installed NPM packages:" \
 && (npm list --omit=dev --all || true)

# Ensure the browser build matches the installed playwright version.
RUN npx playwright install chromium

COPY --chown=myuser:myuser . ./

CMD npm start --silent
