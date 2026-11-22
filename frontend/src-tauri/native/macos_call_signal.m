#import <AppKit/AppKit.h>
#import <CoreAudio/CoreAudio.h>
#import <Foundation/Foundation.h>
#include <libproc.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <unistd.h>

static char *memo_call_dup_utf8(NSString *value) {
    const char *utf8 = value == nil ? "" : value.UTF8String;
    if (utf8 == NULL) utf8 = "";
    size_t length = strlen(utf8);
    char *copy = malloc(length + 1);
    if (copy != NULL) memcpy(copy, utf8, length + 1);
    return copy;
}

static AudioObjectPropertyAddress memo_call_address(AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = {
        .mSelector = selector,
        .mScope = kAudioObjectPropertyScopeGlobal,
        .mElement = kAudioObjectPropertyElementMain,
    };
    return address;
}

static BOOL memo_call_u32(AudioObjectID object, AudioObjectPropertySelector selector, UInt32 *value) {
    AudioObjectPropertyAddress address = memo_call_address(selector);
    UInt32 size = sizeof(*value);
    return AudioObjectGetPropertyData(object, &address, 0, NULL, &size, value) == noErr;
}

static BOOL memo_call_pid(AudioObjectID object, pid_t *value) {
    AudioObjectPropertyAddress address = memo_call_address(kAudioProcessPropertyPID);
    UInt32 size = sizeof(*value);
    return AudioObjectGetPropertyData(object, &address, 0, NULL, &size, value) == noErr;
}

static NSString *memo_call_string(AudioObjectID object, AudioObjectPropertySelector selector) {
    AudioObjectPropertyAddress address = memo_call_address(selector);
    CFStringRef value = NULL;
    UInt32 size = sizeof(value);
    if (AudioObjectGetPropertyData(object, &address, 0, NULL, &size, &value) != noErr || value == NULL) {
        return nil;
    }
    return CFBridgingRelease(value);
}

static pid_t memo_call_parent_pid(pid_t pid) {
    struct kinfo_proc info;
    memset(&info, 0, sizeof(info));
    size_t size = sizeof(info);
    int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return 0;
    return info.kp_eproc.e_ppid;
}

static NSString *memo_call_owning_bundle_id(pid_t pid) {
    pid_t current = pid;
    for (int depth = 0; depth < 6 && current > 1; depth++) {
        NSRunningApplication *app =
            [NSRunningApplication runningApplicationWithProcessIdentifier:current];
        if (app != nil && app.activationPolicy == NSApplicationActivationPolicyRegular &&
            app.bundleIdentifier.length > 0) {
            return app.bundleIdentifier;
        }
        current = memo_call_parent_pid(current);
    }
    return nil;
}

int32_t memo_macos_call_signal_snapshot(char **out_json, char **out_error) {
    if (out_json != NULL) *out_json = NULL;
    if (out_error != NULL) *out_error = NULL;

    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            AudioObjectPropertyAddress address =
                memo_call_address(kAudioHardwarePropertyProcessObjectList);
            UInt32 size = 0;
            OSStatus status = AudioObjectGetPropertyDataSize(
                kAudioObjectSystemObject, &address, 0, NULL, &size
            );
            if (status != noErr) {
                if (out_error != NULL) {
                    *out_error = memo_call_dup_utf8(
                        [NSString stringWithFormat:@"CoreAudio process list failed (%d)", status]
                    );
                }
                return -1;
            }

            NSUInteger count = size / sizeof(AudioObjectID);
            AudioObjectID *objects = calloc(count, sizeof(AudioObjectID));
            if (objects == NULL && count > 0) {
                if (out_error != NULL) *out_error = memo_call_dup_utf8(@"Out of memory");
                return -1;
            }
            status = AudioObjectGetPropertyData(
                kAudioObjectSystemObject, &address, 0, NULL, &size, objects
            );
            if (status != noErr) {
                free(objects);
                if (out_error != NULL) {
                    *out_error = memo_call_dup_utf8(
                        [NSString stringWithFormat:@"CoreAudio process snapshot failed (%d)", status]
                    );
                }
                return -1;
            }

            NSMutableArray *clients = [NSMutableArray arrayWithCapacity:count];
            for (NSUInteger index = 0; index < count; index++) {
                pid_t pid = 0;
                if (!memo_call_pid(objects[index], &pid) || pid <= 0) continue;
                UInt32 input = 0;
                UInt32 output = 0;
                memo_call_u32(objects[index], kAudioProcessPropertyIsRunningInput, &input);
                memo_call_u32(objects[index], kAudioProcessPropertyIsRunningOutput, &output);
                if (input == 0 && output == 0) continue;

                NSString *reported = memo_call_string(
                    objects[index], kAudioProcessPropertyBundleID
                );
                NSString *owner = memo_call_owning_bundle_id(pid);
                [clients addObject:@{
                    @"pid": @(pid),
                    @"reportedId": reported ?: [NSNull null],
                    @"appId": owner ?: [NSNull null],
                    @"inputActive": [NSNumber numberWithBool:(input != 0)],
                    @"outputActive": [NSNumber numberWithBool:(output != 0)],
                }];
            }
            free(objects);

            NSMutableArray *running = [NSMutableArray array];
            for (NSRunningApplication *app in NSWorkspace.sharedWorkspace.runningApplications) {
                if (app.bundleIdentifier.length > 0) {
                    [running addObject:app.bundleIdentifier];
                }
            }
            NSDictionary *payload = @{
                @"supported": @YES,
                @"backend": @"coreaudio-process",
                @"clients": clients,
                @"runningApps": running,
            };
            NSError *error = nil;
            NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&error];
            if (data == nil) {
                if (out_error != NULL) {
                    *out_error = memo_call_dup_utf8(error.localizedDescription ?: @"JSON error");
                }
                return -1;
            }
            if (out_json != NULL) {
                *out_json = memo_call_dup_utf8(
                    [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
                );
            }
            return 0;
        }

        NSDictionary *payload = @{
            @"supported": @NO,
            @"backend": @"coreaudio-device",
            @"clients": @[],
            @"runningApps": @[],
        };
        NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
        if (out_json != NULL) {
            *out_json = memo_call_dup_utf8(
                [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]
            );
        }
        return 0;
    }
}
