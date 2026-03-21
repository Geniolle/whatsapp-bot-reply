//###################################################################################
// src/services/googlePlaces.js - MÓDULO DE PESQUISA GOOGLE MAPS
//###################################################################################
"use strict";

async function getNearbyPlacesFormated_v1({ apiKey, centralAddress, searchTerm, maxResults = 4 }) {
  if (!apiKey) throw new Error("Google Places API Key ausente.");

  // Montamos a pesquisa exata para o Google (ex: "restaurante perto de Praceta Beato Inácio de Azevedo, 7, Braga")
  const query = encodeURIComponent(`${searchTerm} perto de ${centralAddress}`);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&key=${apiKey}`;

  try {
    const response = await fetch(url);
    const data = await response.json();

    if (!data.results || data.results.length === 0) return null;

    const places = data.results.slice(0, maxResults);
    let text = `Aqui estão algumas excelentes opções de *${searchTerm}* perto da igreja, segundo o Google Maps:\n\n`;

    places.forEach((place, index) => {
      const name = place.name;
      // O Google às vezes traz a morada completa com "Portugal", limpamos isso para ficar mais limpo
      let address = place.formatted_address || "Morada não disponível";
      address = address.replace(", Portugal", "");
      
      const rating = place.rating ? `${place.rating} ⭐` : "Sem avaliação";
      const status = place.opening_hours?.open_now ? "🟢 Aberto agora" : (place.opening_hours ? "🔴 Fechado agora" : "🕒 Horário não disponível");

      text += `🍽️ *${name}*\n`;
      text += `📍 Morada: ${address}\n`;
      text += `💡 Status: ${status} | ${rating}\n\n`;
    });

    return text.trim();
  } catch (error) {
    console.error("[GOOGLE PLACES ERROR]", error);
    return null;
  }
}

module.exports = { getNearbyPlacesFormated_v1 };