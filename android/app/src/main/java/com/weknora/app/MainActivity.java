package com.weknora.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // 注册本地插件（必须在 super.onCreate 之前）
        registerPlugin(FileToolsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
