import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { Db } from './db/db.service';
import { AuthController, AuthGuard } from './auth/auth';
import { WahaClient } from './waha/waha.client';
import { SettingsService } from './settings/settings.service';
import { SettingsController } from './settings/settings.controller';
import { AlertsService } from './alerts/alerts.service';
import { NumbersService } from './numbers/numbers.service';
import { NumbersController } from './numbers/numbers.controller';
import { FrappeSyncService } from './contacts/frappe-sync.service';
import { ContactsController } from './contacts/contacts.controller';
import { MediaController } from './media/media.controller';
import { CampaignsService } from './campaigns/campaigns.service';
import { CampaignsController, TemplatesController } from './campaigns/campaigns.controller';
import { SenderService } from './sender/sender.service';
import { WebhooksController } from './webhooks/webhooks.controller';
import { PhoneMaskInterceptor, PrivacyController } from './privacy/privacy';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    AuthController, SettingsController, NumbersController, ContactsController, MediaController,
    CampaignsController, TemplatesController, WebhooksController, PrivacyController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: PhoneMaskInterceptor },
    Db, WahaClient, SettingsService, AlertsService, NumbersService, FrappeSyncService, CampaignsService, SenderService,
  ],
})
export class AppModule {}
