FROM node:14.15.1-alpine3.12

COPY index.js package.json package-lock.json /opt/kasa-watch/

RUN cd /opt/kasa-watch  \
 && npm install

ENTRYPOINT ["/usr/local/bin/node", "/opt/kasa-watch/index.js"]
CMD ["--help"]
