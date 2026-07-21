import { createApp } from "vue";
import App from "./App.vue";

// Vuetify
import "vuetify/styles";
import { createVuetify } from "vuetify";
import * as components from "vuetify/components";
import * as directives from "vuetify/directives";

// Icons
import "@mdi/font/css/materialdesignicons.css";

const vuetify = createVuetify({
  components,
  directives,
  theme: {
    defaultTheme: "warmLight",
    themes: {
      warmLight: {
        dark: false,
        colors: {
          background: "#fff8ef",
          surface: "#fffdf9",
          primary: "#b7795c",
          "primary-darken-2": "#85543d",
          "primary-lighten-5": "#f8eadf",
          secondary: "#8a7a6d",
          "secondary-lighten-5": "#f2ebe4",
          success: "#7f9273",
          "success-lighten-5": "#edf2e8",
          warning: "#b89059",
          "warning-lighten-5": "#f8eed8",
          error: "#b87364",
          "error-lighten-5": "#f8e7df",
          info: "#9c8068",
          "info-lighten-5": "#f1e9df",
          muted: "#9a8a7c",
          "muted-lighten-5": "#f4ede6",
        },
      },
    },
  },
});

createApp(App).use(vuetify).mount("#app");

