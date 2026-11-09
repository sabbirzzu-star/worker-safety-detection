// IISMS ESP32-S3-CAM edge node.
// Captures JPEG frames and POSTs them to the FastAPI /ingest endpoint.
// The backend performs inference; the dashboard displays its annotated stream.

#include <WiFiClientSecure.h>
#include "esp_camera.h"
#include <HTTPClient.h>
#include <WiFi.h>

// ---------- Set these values ----------
const char* WIFI_SSID = "YOUR_WIFI_SSID";
const char* WIFI_PASS = "YOUR_WIFI_PASSWORD";
const char* SERVER_URL = "https://api.bdnextshop.com/ingest";

const uint32_t CAPTURE_PERIOD_MS = 200;  // 5 FPS; camera timing remains controlled
const uint32_t HTTPS_CONNECT_TIMEOUT_MS = 4000;
const uint32_t HTTPS_REQUEST_TIMEOUT_MS = 6000;
const size_t MAX_JPEG_BYTES = 350 * 1024;
const size_t FALLBACK_JPEG_BYTES = 64 * 1024;
// --------------------------------------

// ESP32-S3-CAM pin map supplied for this project.
#define PWDN_GPIO_NUM -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 15
#define SIOD_GPIO_NUM 4
#define SIOC_GPIO_NUM 5
#define Y9_GPIO_NUM 16
#define Y8_GPIO_NUM 17
#define Y7_GPIO_NUM 18
#define Y6_GPIO_NUM 12
#define Y5_GPIO_NUM 10
#define Y4_GPIO_NUM 8
#define Y3_GPIO_NUM 9
#define Y2_GPIO_NUM 11
#define VSYNC_GPIO_NUM 6
#define HREF_GPIO_NUM 7
#define PCLK_GPIO_NUM 13

static bool connect_wifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);

  Serial.print("Connecting to Wi-Fi");
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 30000) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("\nWi-Fi connection timed out.");
    return false;
  }

  Serial.print("\nWi-Fi connected. ESP32 IP: ");
  Serial.println(WiFi.localIP());
  Serial.print("Backend endpoint: ");
  Serial.println(SERVER_URL);
  return true;
}

static bool init_camera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 10000000;
  config.pixel_format = PIXFORMAT_JPEG;

  if (psramFound()) {
    config.frame_size = FRAMESIZE_VGA;
    config.jpeg_quality = 14;
    config.fb_count = 2;
    config.fb_location = CAMERA_FB_IN_PSRAM;
    config.grab_mode = CAMERA_GRAB_LATEST;
  } else {
    config.frame_size = FRAMESIZE_QVGA;
    config.jpeg_quality = 16;
    config.fb_count = 1;
    config.fb_location = CAMERA_FB_IN_DRAM;
    config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;
  }

  const esp_err_t result = esp_camera_init(&config);
  if (result != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", result);
    return false;
  }

  sensor_t* sensor = esp_camera_sensor_get();
  sensor->set_whitebal(sensor, 1);
  sensor->set_awb_gain(sensor, 1);
  sensor->set_exposure_ctrl(sensor, 1);
  sensor->set_gain_ctrl(sensor, 1);
  Serial.println("Camera initialized.");
  return true;
}

struct FrameSlot {
  uint8_t* data;
  size_t length;
};

FrameSlot frameSlots[2] = {};
int slotCount = 0;
size_t frameBufferSize = 0;
volatile int readySlot = -1;
volatile int uploadingSlot = -1;
portMUX_TYPE frameMux = portMUX_INITIALIZER_UNLOCKED;
SemaphoreHandle_t uploadSignal;
WiFiClientSecure httpsClient;
HTTPClient httpsRequest;
bool httpsReady = false;

static void release_https() {
  if (httpsReady) {
    httpsRequest.end();
    httpsReady = false;
  }
}

static bool start_https_connection() {
  httpsClient.setInsecure();
  httpsClient.setTimeout(HTTPS_REQUEST_TIMEOUT_MS);
  httpsRequest.setConnectTimeout(HTTPS_CONNECT_TIMEOUT_MS);
  httpsRequest.setTimeout(HTTPS_REQUEST_TIMEOUT_MS);
  httpsRequest.setReuse(true);

  if (!httpsRequest.begin(httpsClient, SERVER_URL)) {
    Serial.println("Could not configure HTTPS client.");
    release_https();
    return false;
  }

  httpsRequest.addHeader("Content-Type", "image/jpeg");
  httpsRequest.addHeader("Cache-Control", "no-cache");
  httpsRequest.addHeader("Connection", "keep-alive");
  httpsRequest.addHeader("Accept-Encoding", "identity");
  httpsReady = true;
  return true;
}

static bool post_buffer(uint8_t* data, size_t length) {
  if (WiFi.status() != WL_CONNECTED) {
    release_https();
    return false;
  }
  if (!httpsReady && !start_https_connection()) return false;

  const int status = httpsRequest.POST(data, length);
  const bool accepted = status >= 200 && status < 300;
  if (accepted) {
    Serial.printf("Frame sent: %u bytes, HTTPS %d\n", length, status);
  } else {
    Serial.printf("Frame upload failed: HTTPS %d (%s)\n", status, httpsRequest.errorToString(status).c_str());
    release_https();
  }
  return accepted;
}

static void uploader_task(void*) {
  for (;;) {
    if (xSemaphoreTake(uploadSignal, portMAX_DELAY) != pdTRUE) continue;

    int slot = -1;
    portENTER_CRITICAL(&frameMux);
    slot = readySlot;
    readySlot = -1;
    uploadingSlot = slot;
    portEXIT_CRITICAL(&frameMux);

    if (slot >= 0) {
      post_buffer(frameSlots[slot].data, frameSlots[slot].length);
    }
    portENTER_CRITICAL(&frameMux);
    uploadingSlot = -1;
    portEXIT_CRITICAL(&frameMux);
  }
}

static bool publish_frame(camera_fb_t* frame) {
  int slot = -1;
  portENTER_CRITICAL(&frameMux);
  for (int i = 0; i < slotCount; ++i) {
    if (i != uploadingSlot) {
      slot = i;
      break;
    }
  }
  portEXIT_CRITICAL(&frameMux);

  if (slot < 0 || frame->len > frameBufferSize) {
    Serial.printf("Frame skipped: %u bytes, upload buffer busy or frame too large\n", frame->len);
    return false;
  }

  memcpy(frameSlots[slot].data, frame->buf, frame->len);
  frameSlots[slot].length = frame->len;
  portENTER_CRITICAL(&frameMux);
  readySlot = slot;
  portEXIT_CRITICAL(&frameMux);
  xSemaphoreGive(uploadSignal);
  return true;
}

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.flush();
  Serial.println("\nIISMS ESP32-S3-CAM uploader starting...");
  Serial.printf("Free heap: %lu bytes, PSRAM: %s (%lu bytes free)\n",
                static_cast<unsigned long>(ESP.getFreeHeap()),
                psramFound() ? "yes" : "no",
                static_cast<unsigned long>(ESP.getFreePsram()));

  if (!init_camera()) {
    Serial.println("Restarting after camera initialization failure.");
    delay(3000);
    ESP.restart();
  }

  while (!connect_wifi()) {
    delay(5000);
  }

  const bool hasPsram = psramFound();
  const size_t bufferSize = hasPsram ? MAX_JPEG_BYTES : FALLBACK_JPEG_BYTES;
  frameBufferSize = bufferSize;
  slotCount = 2;
  for (int i = 0; i < slotCount; ++i) {
    frameSlots[i].data = hasPsram
      ? static_cast<uint8_t*>(ps_malloc(bufferSize))
      : static_cast<uint8_t*>(malloc(bufferSize));
    if (frameSlots[i].data == nullptr) {
      if (i == 1) {
        slotCount = 1;
        Serial.println("Second frame buffer unavailable; using single-buffer mode.");
        break;
      }
      Serial.printf("Frame buffer allocation failed: %u bytes\n", bufferSize);
      while (true) delay(1000);
    }
  }
  Serial.printf("Uploader buffers: %d x %u bytes\n", slotCount, bufferSize);
  uploadSignal = xSemaphoreCreateBinary();
  if (uploadSignal == nullptr) {
    Serial.println("Could not create uploader signal.");
    delay(3000);
    ESP.restart();
  }
  xTaskCreatePinnedToCore(uploader_task, "iis upl", 8192, nullptr, 1, nullptr, 0);
}

void loop() {
  const uint32_t started = millis();

  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("Wi-Fi lost; reconnecting.");
    WiFi.disconnect();
    while (!connect_wifi()) {
      delay(5000);
    }
  }

  camera_fb_t* frame = esp_camera_fb_get();
  if (frame == nullptr) {
    Serial.println("Camera capture failed.");
  } else {
    publish_frame(frame);
    esp_camera_fb_return(frame);
  }

  const uint32_t elapsed = millis() - started;
  if (elapsed < CAPTURE_PERIOD_MS) {
    delay(CAPTURE_PERIOD_MS - elapsed);
  } else {
    delay(1);
  }
}
