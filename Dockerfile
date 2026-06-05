# Utilizza un'immagine ufficiale leggera di Node.js come base
FROM node:20-alpine

# Imposta la directory di lavoro nel container
WORKDIR /app/marcature

# Copia i file delle dipendenze
COPY package*.json ./

# Installa solo le dipendenze di produzione (evita sqlite3 se non necessario, ma installa pg e il resto)
RUN npm ci --only=production

# Copia il resto dell'applicazione
COPY . .

# Espone la porta usata dall'applicazione
EXPOSE 8000

# Comando di avvio dell'applicazione
CMD ["npm", "start"]
