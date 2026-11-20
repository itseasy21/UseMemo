#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static char *memo_capture_dup_utf8(NSString *str) {
    if (str == nil) {
        char *empty = (char *)malloc(1);
        if (empty != NULL) {
            empty[0] = '\0';
        }
        return empty;
    }
    const char *utf8 = [str UTF8String];
    if (utf8 == NULL) {
        utf8 = "";
    }
    size_t len = strlen(utf8);
    char *copy = (char *)malloc(len + 1);
    if (copy != NULL) {
        memcpy(copy, utf8, len + 1);
    }
    return copy;
}

int32_t memo_macos_list_capture_targets(char **out_json, char **out_error) {
    if (out_json != NULL) {
        *out_json = NULL;
    }
    if (out_error != NULL) {
        *out_error = NULL;
    }

    @autoreleasepool {
        NSMutableArray<NSDictionary *> *items = [NSMutableArray array];

        uint32_t displayCount = 0;
        CGDirectDisplayID displays[16];
        if (CGGetActiveDisplayList(16, displays, &displayCount) == kCGErrorSuccess) {
            for (uint32_t i = 0; i < displayCount; i++) {
                CGDirectDisplayID d = displays[i];
                size_t w = CGDisplayPixelsWide(d);
                size_t h = CGDisplayPixelsHigh(d);
                BOOL isMain = CGDisplayIsMain(d) ? YES : NO;
                NSString *title = isMain
                    ? [NSString stringWithFormat:@"Main Display (%zux%zu)", w, h]
                    : [NSString stringWithFormat:@"Display %u (%zux%zu)", i + 1, w, h];
                [items addObject:@{
                    @"kind": @"display",
                    @"id": @(d),
                    @"title": title,
                    @"appName": @"Display",
                    @"width": @(w),
                    @"height": @(h),
                }];
            }
        }

        pid_t selfPid = getpid();
        CFArrayRef windowList = CGWindowListCopyWindowInfo(
            kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements,
            kCGNullWindowID
        );
        if (windowList != NULL) {
            NSArray *windows = (__bridge_transfer NSArray *)windowList;
            for (NSDictionary *win in windows) {
                NSNumber *layerNum = win[(id)kCGWindowLayer];
                if (layerNum == nil || [layerNum intValue] != 0) {
                    continue;
                }
                NSNumber *ownerPid = win[(id)kCGWindowOwnerPID];
                if (ownerPid != nil && [ownerPid intValue] == (int)selfPid) {
                    continue;
                }
                NSNumber *winId = win[(id)kCGWindowNumber];
                if (winId == nil || [winId unsignedIntValue] == 0) {
                    continue;
                }
                NSDictionary *boundsDict = win[(id)kCGWindowBounds];
                CGRect bounds = CGRectZero;
                if (boundsDict != nil) {
                    CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)boundsDict, &bounds);
                }
                if (bounds.size.width < 200.0 || bounds.size.height < 140.0) {
                    continue;
                }
                NSString *ownerName = win[(id)kCGWindowOwnerName] ?: @"Application";
                NSString *winTitle = win[(id)kCGWindowName] ?: @"";
                NSString *displayTitle = winTitle.length > 0
                    ? [NSString stringWithFormat:@"%@ — %@", ownerName, winTitle]
                    : ownerName;

                [items addObject:@{
                    @"kind": @"window",
                    @"id": winId,
                    @"title": displayTitle,
                    @"appName": ownerName,
                    @"width": @((uint32_t)bounds.size.width),
                    @"height": @((uint32_t)bounds.size.height),
                }];
            }
        }

        NSError *jsonErr = nil;
        NSData *jsonData = [NSJSONSerialization dataWithJSONObject:items options:0 error:&jsonErr];
        if (jsonData == nil || jsonErr != nil) {
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8([jsonErr localizedDescription] ?: @"JSON encode error");
            }
            return -1;
        }
        NSString *jsonStr = [[NSString alloc] initWithData:jsonData encoding:NSUTF8StringEncoding];
        if (out_json != NULL) {
            *out_json = memo_capture_dup_utf8(jsonStr);
        }
        return 0;
    }
}

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static CGImageRef memo_capture_cgimage(int32_t target_kind, uint32_t target_id) {
    if (target_kind == 1 && target_id != 0) {
        return CGDisplayCreateImage((CGDirectDisplayID)target_id);
    }
    if (target_kind == 2 && target_id != 0) {
        return CGWindowListCreateImage(
            CGRectNull,
            kCGWindowListOptionIncludingWindow,
            (CGWindowID)target_id,
            kCGWindowImageBoundsIgnoreFraming | kCGWindowImageBestResolution
        );
    }

    // Default (`Auto`): capture main display bounds while excluding our own
    // floating HUD window so overlays never pollute meeting slide captures.
    pid_t selfPid = getpid();
    CGRect mainBounds = CGDisplayBounds(CGMainDisplayID());
    CFArrayRef infoArray = CGWindowListCopyWindowInfo(
        kCGWindowListOptionOnScreenOnly,
        kCGNullWindowID
    );
    if (infoArray != NULL) {
        CFIndex count = CFArrayGetCount(infoArray);
        CFMutableArrayRef allowedIds = CFArrayCreateMutable(kCFAllocatorDefault, count, NULL);
        for (CFIndex i = 0; i < count; i++) {
            NSDictionary *entry = (__bridge NSDictionary *)CFArrayGetValueAtIndex(infoArray, i);
            NSNumber *pidNum = entry[(id)kCGWindowOwnerPID];
            NSNumber *layerNum = entry[(id)kCGWindowLayer];
            NSString *winName = entry[(id)kCGWindowName] ?: @"";
            if (pidNum != nil && [pidNum intValue] == (int)selfPid) {
                // Exclude floating HUD windows (`alwaysOnTop` layer > 0 or HUD title)
                if ((layerNum != nil && [layerNum intValue] > 0) ||
                    [winName localizedCaseInsensitiveContainsString:@"HUD"]) {
                    continue;
                }
            }
            NSNumber *winNum = entry[(id)kCGWindowNumber];
            if (winNum != nil) {
                CGWindowID wid = (CGWindowID)[winNum unsignedIntValue];
                CFArrayAppendValue(allowedIds, (const void *)(uintptr_t)wid);
            }
        }
        CFRelease(infoArray);

        CGImageRef img = NULL;
        if (CFArrayGetCount(allowedIds) > 0) {
            img = CGWindowListCreateImageFromArray(
                mainBounds,
                allowedIds,
                kCGWindowImageDefault
            );
        }
        CFRelease(allowedIds);
        if (img != NULL) {
            return img;
        }
    }

    return CGDisplayCreateImage(CGMainDisplayID());
}

#pragma clang diagnostic pop

int32_t memo_macos_capture_target_rgba(
    int32_t target_kind,
    uint32_t target_id,
    uint32_t max_width,
    uint8_t **out_rgba,
    uint32_t *out_width,
    uint32_t *out_height,
    char **out_error
) {
    if (out_rgba != NULL) *out_rgba = NULL;
    if (out_width != NULL) *out_width = 0;
    if (out_height != NULL) *out_height = 0;
    if (out_error != NULL) *out_error = NULL;

    @autoreleasepool {
        if (!CGPreflightScreenCaptureAccess()) {
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8(
                    @"Screen capture requires Screen Recording permission in System Settings -> Privacy & Security"
                );
            }
            return -1;
        }

        CGImageRef cgImage = memo_capture_cgimage(target_kind, target_id);
        if (cgImage == NULL) {
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8(
                    @"Screen capture returned an empty image; verify the selected window/display is visible and Screen Recording is granted"
                );
            }
            return -1;
        }

        size_t srcW = CGImageGetWidth(cgImage);
        size_t srcH = CGImageGetHeight(cgImage);
        if (srcW == 0 || srcH == 0) {
            CGImageRelease(cgImage);
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8(@"Captured image had zero dimensions");
            }
            return -1;
        }

        uint32_t dstW = (uint32_t)srcW;
        uint32_t dstH = (uint32_t)srcH;
        if (max_width > 0 && dstW > max_width) {
            double scale = (double)max_width / (double)dstW;
            dstW = max_width;
            dstH = (uint32_t)((double)srcH * scale);
            if (dstH == 0) {
                dstH = 1;
            }
        }

        size_t rowBytes = (size_t)dstW * 4;
        size_t totalBytes = rowBytes * (size_t)dstH;
        uint8_t *buffer = (uint8_t *)calloc(1, totalBytes);
        if (buffer == NULL) {
            CGImageRelease(cgImage);
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8(@"Out of memory allocating screenshot buffer");
            }
            return -1;
        }

        CGColorSpaceRef colorSpace = CGColorSpaceCreateDeviceRGB();
        CGBitmapInfo bitmapInfo =
            (CGBitmapInfo)kCGImageAlphaPremultipliedLast | (CGBitmapInfo)kCGBitmapByteOrder32Big;
        CGContextRef context = CGBitmapContextCreate(
            buffer,
            (size_t)dstW,
            (size_t)dstH,
            8,
            rowBytes,
            colorSpace,
            bitmapInfo
        );
        CGColorSpaceRelease(colorSpace);

        if (context == NULL) {
            free(buffer);
            CGImageRelease(cgImage);
            if (out_error != NULL) {
                *out_error = memo_capture_dup_utf8(@"Could not create RGBA bitmap context");
            }
            return -1;
        }

        CGContextSetInterpolationQuality(context, kCGInterpolationHigh);
        CGContextDrawImage(context, CGRectMake(0, 0, (CGFloat)dstW, (CGFloat)dstH), cgImage);
        CGContextRelease(context);
        CGImageRelease(cgImage);

        if (out_rgba != NULL) *out_rgba = buffer;
        if (out_width != NULL) *out_width = dstW;
        if (out_height != NULL) *out_height = dstH;
        return 0;
    }
}

void memo_macos_free_buffer(uint8_t *ptr) {
    if (ptr != NULL) {
        free(ptr);
    }
}

void memo_macos_free_string(char *ptr) {
    if (ptr != NULL) {
        free(ptr);
    }
}
