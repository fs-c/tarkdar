// The overlay window on Wayland: a wlr-layer-shell surface on the "overlay" layer (above fullscreen
// windows; KDE Plasma, Sway, Hyprland and other wlroots compositors support it, GNOME doesn't),
// anchored to all edges of one output, with an empty input region so every click goes through to
// what's beneath. Drawn with OpenGL ES 3 through EGL; shapes and text with Dear ImGui's draw lists.
//
// Frame pacing: a frame is drawn when the compositor's frame callback says it's ready for one, with
// the cameras read right then (Frames::frame), and swapped without waiting for vsync. While the
// frames are inactive, one transparent frame is drawn and no more are asked for; a poll every
// kIdleCheck notices when to start again.

#include "overlay/Window.hpp"

#include "core/log/Log.hpp"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <wayland-client.h>
#include <wayland-egl.h>

// The generated header names a parameter "namespace", a C++ keyword.
#define namespace namespace_
#include "wlr-layer-shell-unstable-v1-client-protocol.h"
#undef namespace

#include <backends/imgui_impl_opengl3.h>
#include <imgui.h>

#include <poll.h>

#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <memory>
#include <vector>

namespace radar::overlay {

namespace {

constexpr int kIdleCheckMs = 50;

// Tried in order when no font is given: common locations on Arch, Debian/Ubuntu and Fedora.
constexpr std::array kSystemFonts = {
    "/usr/share/fonts/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/google-noto/NotoSans-Regular.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
};

struct Output {
    wl_output* output = nullptr;
    std::uint32_t globalName = 0;
    std::string name;
    std::int32_t scale = 1;
};

struct Window {
    Frames& frames;
    std::string wantedOutput;

    wl_display* display = nullptr;
    wl_registry* registry = nullptr;
    wl_compositor* compositor = nullptr;
    zwlr_layer_shell_v1* layerShell = nullptr;
    std::vector<std::unique_ptr<Output>> outputs;

    wl_surface* surface = nullptr;
    zwlr_layer_surface_v1* layer = nullptr;
    Output* output = nullptr;  // the chosen one, if any
    int width = 0, height = 0;  // logical
    int scale = 1;
    int preferredScale = 0;  // wl_surface.preferred_buffer_scale, if sent
    bool configured = false;
    bool closed = false;

    wl_egl_window* eglWindow = nullptr;
    EGLDisplay egl = EGL_NO_DISPLAY;
    EGLContext context = EGL_NO_CONTEXT;
    EGLSurface eglSurface = EGL_NO_SURFACE;
    EGLConfig eglConfig = nullptr;
    bool imgui = false;

    wl_callback* frameCallback = nullptr;
    bool drewEmpty = false;
    bool test = false;  // WindowOptions::test
    std::chrono::steady_clock::time_point lastFrame{};

    explicit Window(Frames& f, std::string out) : frames(f), wantedOutput(std::move(out)) {}
    ~Window();

    std::expected<void, std::string> open(const WindowOptions& options);
    void resize();
    void draw();
    void scheduleFrame();
};

// ---- Wayland listeners ----------------------------------------------------------------------------

void outputGeometry(void*, wl_output*, int32_t, int32_t, int32_t, int32_t, int32_t, const char*, const char*, int32_t) {}
void outputMode(void*, wl_output*, uint32_t, int32_t, int32_t, int32_t) {}
void outputDone(void*, wl_output*) {}
void outputScale(void* data, wl_output*, int32_t factor) { static_cast<Output*>(data)->scale = factor; }
void outputName(void* data, wl_output*, const char* name) { static_cast<Output*>(data)->name = name; }
void outputDescription(void*, wl_output*, const char*) {}
const wl_output_listener kOutputListener{outputGeometry, outputMode, outputDone, outputScale, outputName, outputDescription};

void registryGlobal(void* data, wl_registry* registry, uint32_t name, const char* interface, uint32_t version) {
    auto& w = *static_cast<Window*>(data);
    if (std::strcmp(interface, wl_compositor_interface.name) == 0) {
        w.compositor = static_cast<wl_compositor*>(wl_registry_bind(registry, name, &wl_compositor_interface, std::min(version, 6u)));
    } else if (std::strcmp(interface, zwlr_layer_shell_v1_interface.name) == 0) {
        w.layerShell = static_cast<zwlr_layer_shell_v1*>(wl_registry_bind(registry, name, &zwlr_layer_shell_v1_interface, std::min(version, 4u)));
    } else if (std::strcmp(interface, wl_output_interface.name) == 0) {
        auto out = std::make_unique<Output>();
        out->globalName = name;
        out->output = static_cast<wl_output*>(wl_registry_bind(registry, name, &wl_output_interface, std::min(version, 4u)));
        wl_output_add_listener(out->output, &kOutputListener, out.get());
        w.outputs.push_back(std::move(out));
    }
}
void registryRemove(void*, wl_registry*, uint32_t) {}
const wl_registry_listener kRegistryListener{registryGlobal, registryRemove};

void layerConfigure(void* data, zwlr_layer_surface_v1* layer, uint32_t serial, uint32_t width, uint32_t height) {
    auto& w = *static_cast<Window*>(data);
    zwlr_layer_surface_v1_ack_configure(layer, serial);
    w.width = static_cast<int>(width);
    w.height = static_cast<int>(height);
    w.configured = true;
    w.resize();
}
void layerClosed(void* data, zwlr_layer_surface_v1*) { static_cast<Window*>(data)->closed = true; }
const zwlr_layer_surface_v1_listener kLayerListener{layerConfigure, layerClosed};

void surfaceEnter(void* data, wl_surface*, wl_output* output) {
    auto& w = *static_cast<Window*>(data);
    for (auto& o : w.outputs)
        if (o->output == output && !w.output) w.output = o.get();
    w.resize();
}
void surfaceLeave(void*, wl_surface*, wl_output*) {}
void surfacePreferredScale(void* data, wl_surface*, int32_t factor) {
    auto& w = *static_cast<Window*>(data);
    w.preferredScale = factor;
    w.resize();
}
void surfacePreferredTransform(void*, wl_surface*, uint32_t) {}
const wl_surface_listener kSurfaceListener{surfaceEnter, surfaceLeave, surfacePreferredScale, surfacePreferredTransform};

void frameDone(void* data, wl_callback* callback, uint32_t) {
    auto& w = *static_cast<Window*>(data);
    wl_callback_destroy(callback);
    w.frameCallback = nullptr;
    w.draw();
}
const wl_callback_listener kFrameListener{frameDone};

ImU32 colorOf(Color c) { return IM_COL32(c.r, c.g, c.b, c.a); }
ImVec2 vec(Point p) { return {p.x, p.y}; }

// ---- Window ---------------------------------------------------------------------------------------

std::expected<void, std::string> Window::open(const WindowOptions& options) {
    display = wl_display_connect(nullptr);
    if (!display) return std::unexpected("no Wayland session (WAYLAND_DISPLAY not set or not reachable)");
    registry = wl_display_get_registry(display);
    wl_registry_add_listener(registry, &kRegistryListener, this);
    wl_display_roundtrip(display);  // globals
    wl_display_roundtrip(display);  // output names and scales
    if (!compositor) return std::unexpected("the compositor has no wl_compositor");
    if (!layerShell) return std::unexpected("the compositor doesn't support wlr-layer-shell (GNOME doesn't; KDE Plasma and wlroots compositors do)");

    if (!wantedOutput.empty()) {
        for (auto& o : outputs)
            if (o->name == wantedOutput) output = o.get();
        if (!output) {
            std::string names;
            for (auto& o : outputs) names += (names.empty() ? "" : ", ") + o->name;
            return std::unexpected(std::format("no output named '{}' (outputs: {})", wantedOutput, names));
        }
    }

    surface = wl_compositor_create_surface(compositor);
    wl_surface_add_listener(surface, &kSurfaceListener, this);
    layer = zwlr_layer_shell_v1_get_layer_surface(layerShell, surface, output ? output->output : nullptr,
                                                  ZWLR_LAYER_SHELL_V1_LAYER_OVERLAY, "radar-overlay");
    zwlr_layer_surface_v1_add_listener(layer, &kLayerListener, this);
    zwlr_layer_surface_v1_set_anchor(layer, ZWLR_LAYER_SURFACE_V1_ANCHOR_TOP | ZWLR_LAYER_SURFACE_V1_ANCHOR_BOTTOM |
                                                ZWLR_LAYER_SURFACE_V1_ANCHOR_LEFT | ZWLR_LAYER_SURFACE_V1_ANCHOR_RIGHT);
    zwlr_layer_surface_v1_set_size(layer, 0, 0);
    zwlr_layer_surface_v1_set_exclusive_zone(layer, -1);  // the whole output, panels or not
    zwlr_layer_surface_v1_set_keyboard_interactivity(layer, ZWLR_LAYER_SURFACE_V1_KEYBOARD_INTERACTIVITY_NONE);
    // Click-through: input goes to whatever is beneath.
    wl_region* none = wl_compositor_create_region(compositor);
    wl_surface_set_input_region(surface, none);
    wl_region_destroy(none);
    wl_surface_commit(surface);
    while (!configured && !closed)
        if (wl_display_dispatch(display) < 0) return std::unexpected("lost the Wayland connection");
    if (closed) return std::unexpected("the compositor closed the overlay surface");

    // EGL / OpenGL ES 3.
    egl = eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR, display, nullptr);
    if (egl == EGL_NO_DISPLAY || !eglInitialize(egl, nullptr, nullptr)) return std::unexpected("EGL: can't initialise");
    eglBindAPI(EGL_OPENGL_ES_API);
    const EGLint configAttribs[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT,
                                    EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 8, EGL_NONE};
    EGLint count = 0;
    if (!eglChooseConfig(egl, configAttribs, &eglConfig, 1, &count) || count < 1)
        return std::unexpected("EGL: no RGBA8 OpenGL ES 3 config");
    const EGLint contextAttribs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE};
    context = eglCreateContext(egl, eglConfig, EGL_NO_CONTEXT, contextAttribs);
    if (context == EGL_NO_CONTEXT) return std::unexpected("EGL: can't create an OpenGL ES 3 context");
    resize();
    if (eglSurface == EGL_NO_SURFACE) return std::unexpected("EGL: can't create the window surface");

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    imgui = true;
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;
    io.LogFilename = nullptr;
    std::string font = options.font;
    if (font.empty())
        for (const char* f : kSystemFonts)
            if (std::error_code ec; std::filesystem::is_regular_file(f, ec)) {
                font = f;
                break;
            }
    if (font.empty() || !io.Fonts->AddFontFromFileTTF(font.c_str(), options.fontSize)) {
        if (!font.empty()) log::warn("overlay: can't load font {}; using the built-in one", font);
        io.Fonts->AddFontDefault();
    }
    if (!ImGui_ImplOpenGL3_Init("#version 300 es")) return std::unexpected("can't set up the OpenGL ES renderer");
    log::info("overlay: {}x{} on {} (scale {}), font {}", width, height, output ? output->name : "the compositor's choice of output",
              scale, font.empty() ? "built-in" : font);
    return {};
}

void Window::resize() {
    if (!configured || egl == EGL_NO_DISPLAY || context == EGL_NO_CONTEXT || width <= 0 || height <= 0) return;
    scale = std::max(1, preferredScale ? preferredScale : output ? output->scale : 1);
    wl_surface_set_buffer_scale(surface, scale);
    if (!eglWindow) {
        eglWindow = wl_egl_window_create(surface, width * scale, height * scale);
        eglSurface = eglCreateWindowSurface(egl, eglConfig, reinterpret_cast<EGLNativeWindowType>(eglWindow), nullptr);
        if (eglSurface == EGL_NO_SURFACE) return;
        eglMakeCurrent(egl, eglSurface, eglSurface, context);
        eglSwapInterval(egl, 0);  // paced by frame callbacks: swapping mustn't wait as well
    } else {
        wl_egl_window_resize(eglWindow, width * scale, height * scale, 0, 0);
    }
}

void Window::scheduleFrame() {
    if (frameCallback) return;
    frameCallback = wl_surface_frame(surface);
    wl_callback_add_listener(frameCallback, &kFrameListener, this);
}

void Window::draw() {
    if (eglSurface == EGL_NO_SURFACE) return;
    const auto now = std::chrono::steady_clock::now();
    const bool active = test || frames.active();
    if (!active && drewEmpty) return;  // nothing to draw, and it's already clear
    DrawList list = frames.frame(static_cast<float>(width), static_cast<float>(height), now);
    if (test) {
        DrawList pattern = frames.testPattern(static_cast<float>(width), static_cast<float>(height), list);
        list.items.insert(list.items.begin(), std::make_move_iterator(pattern.items.begin()),
                          std::make_move_iterator(pattern.items.end()));
    }
    drewEmpty = list.empty();

    ImGuiIO& io = ImGui::GetIO();
    io.DisplaySize = {static_cast<float>(width), static_cast<float>(height)};
    io.DisplayFramebufferScale = {static_cast<float>(scale), static_cast<float>(scale)};
    const float dt = lastFrame == decltype(lastFrame){} ? 1.f / 60 : std::chrono::duration<float>(now - lastFrame).count();
    io.DeltaTime = std::max(dt, 1e-4f);
    lastFrame = now;
    ImGui_ImplOpenGL3_NewFrame();
    ImGui::NewFrame();
    ImDrawList* dl = ImGui::GetBackgroundDrawList();
    for (const auto& item : list.items) {
        std::visit(
            [&](const auto& d) {
                using T = std::decay_t<decltype(d)>;
                if constexpr (std::is_same_v<T, DrawList::Line>) {
                    dl->AddLine(vec(d.a), vec(d.b), IM_COL32(0, 0, 0, d.color.a / 2), d.width + 2);  // outline: readable on any background
                    dl->AddLine(vec(d.a), vec(d.b), colorOf(d.color), d.width);
                } else if constexpr (std::is_same_v<T, DrawList::Circle>) {
                    if (d.width > 0) dl->AddCircle(vec(d.center), d.radius, colorOf(d.color), 0, d.width);
                    else {
                        if (d.radius >= 2) dl->AddCircleFilled(vec(d.center), d.radius + 1, IM_COL32(0, 0, 0, d.color.a / 2));
                        dl->AddCircleFilled(vec(d.center), d.radius, colorOf(d.color));
                    }
                } else if constexpr (std::is_same_v<T, DrawList::Polygon>) {
                    std::vector<ImVec2> pts;
                    for (const Point p : d.points) pts.push_back(vec(p));
                    if (d.width > 0) dl->AddPolyline(pts.data(), static_cast<int>(pts.size()), colorOf(d.color), ImDrawFlags_Closed, d.width);
                    else dl->AddConvexPolyFilled(pts.data(), static_cast<int>(pts.size()), colorOf(d.color));
                } else if constexpr (std::is_same_v<T, DrawList::Text>) {
                    dl->AddText(nullptr, d.size, {d.at.x + 1, d.at.y + 1}, IM_COL32(0, 0, 0, d.color.a), d.text.c_str());
                    dl->AddText(nullptr, d.size, vec(d.at), colorOf(d.color), d.text.c_str());
                }
            },
            item);
    }
    ImGui::Render();
    glViewport(0, 0, width * scale, height * scale);
    glClearColor(0, 0, 0, 0);
    glClear(GL_COLOR_BUFFER_BIT);
    ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
    if (active) scheduleFrame();  // before the swap, which commits the surface with it
    eglSwapBuffers(egl, eglSurface);
}

Window::~Window() {
    if (imgui) {
        ImGui_ImplOpenGL3_Shutdown();
        ImGui::DestroyContext();
    }
    if (frameCallback) wl_callback_destroy(frameCallback);
    if (egl != EGL_NO_DISPLAY) {
        eglMakeCurrent(egl, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
        if (eglSurface != EGL_NO_SURFACE) eglDestroySurface(egl, eglSurface);
        if (context != EGL_NO_CONTEXT) eglDestroyContext(egl, context);
        eglTerminate(egl);
    }
    if (eglWindow) wl_egl_window_destroy(eglWindow);
    if (layer) zwlr_layer_surface_v1_destroy(layer);
    if (surface) wl_surface_destroy(surface);
    for (auto& o : outputs) wl_output_destroy(o->output);
    if (layerShell) zwlr_layer_shell_v1_destroy(layerShell);
    if (compositor) wl_compositor_destroy(compositor);
    if (registry) wl_registry_destroy(registry);
    if (display) wl_display_disconnect(display);
}

}  // namespace

std::expected<void, std::string> runOverlayWindow(std::stop_token stop, const WindowOptions& options, Frames& frames) {
    Window w(frames, options.output);
    w.test = options.test;
    if (auto opened = w.open(options); !opened) return opened;
    w.draw();
    pollfd fd{.fd = wl_display_get_fd(w.display), .events = POLLIN, .revents = 0};
    while (!stop.stop_requested() && !w.closed) {
        while (wl_display_prepare_read(w.display) != 0) wl_display_dispatch_pending(w.display);
        wl_display_flush(w.display);
        if (poll(&fd, 1, kIdleCheckMs) > 0) {
            if (wl_display_read_events(w.display) < 0) return std::unexpected("lost the Wayland connection");
        } else {
            wl_display_cancel_read(w.display);
        }
        wl_display_dispatch_pending(w.display);
        // Woken up: start drawing again, or draw the clear frame, if no frame is pending.
        if (!w.frameCallback && (w.test || w.frames.active() || !w.drewEmpty)) w.draw();
    }
    if (w.closed) return std::unexpected("the compositor closed the overlay surface");
    return {};
}

}  // namespace radar::overlay
